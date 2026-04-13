import io
import os
import sys
import json
import urllib.request
from pypdf import PdfReader, PdfWriter
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.oauth2.service_account import Credentials


def fetch_pdf(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def split_pdf(pdf_bytes: bytes) -> tuple[bytes, bytes]:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    total = len(reader.pages)
    mid = total // 2
    print(f"Total pages: {total}, splitting at page {mid}")

    def write_half(start, end) -> bytes:
        writer = PdfWriter()
        for i in range(start, end):
            writer.add_page(reader.pages[i])
        buf = io.BytesIO()
        writer.write(buf)
        return buf.getvalue()

    return write_half(0, mid), write_half(mid, total)


def upload_to_drive(service, name: str, data: bytes, folder_id: str) -> str:
    media = MediaIoBaseUpload(io.BytesIO(data), mimetype="application/pdf")
    file = service.files().create(
        body={"name": name, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True        # <-- required for Shared Drives
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
    part1, part2 = split_pdf(pdf_bytes)

    id1 = upload_to_drive(service, f"{base_name}_part1.pdf", part1, folder_id)
    id2 = upload_to_drive(service, f"{base_name}_part2.pdf", part2, folder_id)

    print(f"DRIVE_FILE_ID_1={id1}")
    print(f"DRIVE_FILE_ID_2={id2}")
