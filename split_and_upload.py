import io
import os
import sys
import json
import urllib.request
from pypdf import PdfReader, PdfWriter
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.oauth2.service_account import Credentials


PAGES_PER_CHUNK = 10  # adjust as needed


def fetch_pdf(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def split_pdf_into_chunks(pdf_bytes: bytes, pages_per_chunk: int) -> list[bytes]:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    total = len(reader.pages)
    chunks = []

    for start in range(0, total, pages_per_chunk):
        end = min(start + pages_per_chunk, total)
        writer = PdfWriter()
        for i in range(start, end):
            writer.add_page(reader.pages[i])
        buf = io.BytesIO()
        writer.write(buf)
        chunks.append(buf.getvalue())
        print(f"Chunk {len(chunks)}: pages {start+1}–{end} ({len(chunks[-1]) / 1_000_000:.1f} MB)")

    return chunks


def upload_to_drive(service, name: str, data: bytes, folder_id: str) -> str:
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype="application/pdf")
    file = service.files().create(
        body={"name": name, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True
    ).execute()
    return file["id"]


if __name__ == "__main__":
    url, folder_id, base_name = sys.argv[1], sys.argv[2], sys.argv[3]

    creds = Credentials.from_service_account_info(
        json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]),
        scopes=["https://www.googleapis.com/auth/drive.file"]
    )
    service = build("drive", "v3", credentials=creds)

    print(f"Fetching: {url}")
    pdf_bytes = fetch_pdf(url)
    print(f"Downloaded: {len(pdf_bytes) / 1_000_000:.1f} MB")

    chunks = split_pdf_into_chunks(pdf_bytes, PAGES_PER_CHUNK)
    print(f"Split into {len(chunks)} chunks")

    ids = []
    for i, chunk in enumerate(chunks):
        name = f"{base_name}_part{i+1}.pdf"
        file_id = upload_to_drive(service, name, chunk, folder_id)
        ids.append(file_id)
        print(f"Uploaded {name} → {file_id}")

    # Print all IDs on one line so Apps Script can parse them
    print(f"DRIVE_FILE_IDS={','.join(ids)}")
