import io
import os
import sys
import json
import time
import urllib.request
from pypdf import PdfReader, PdfWriter
from google import genai
from google.genai import types
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.oauth2.service_account import Credentials

CHUNK_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB per chunk

PROMPT = """You are reading a church/parish bulletin PDF.
Extract ONLY the event announcements from this document.
Return them as a plain bulleted list using "•" bullets, one event per bullet.
Include the event name, date/time if present, and a brief description.
Do not include mass schedules, regular weekly items, or administrative notices.
If there are no event announcements, return "• No event announcements found." """


def fetch_pdf(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def split_pdf_into_chunks(pdf_bytes: bytes, chunk_size: int) -> list[bytes]:
    reader = PdfReader(io.BytesIO(pdf_bytes))
    chunks = []
    writer = PdfWriter()
    current_size = 0

    for i, page in enumerate(reader.pages):
        temp = PdfWriter()
        temp.add_page(page)
        buf = io.BytesIO()
        temp.write(buf)
        page_size = buf.tell()

        if current_size + page_size > chunk_size and writer.pages:
            out = io.BytesIO()
            writer.write(out)
            chunks.append(out.getvalue())
            print(f"Chunk {len(chunks)}: {len(chunks[-1]) / 1_000_000:.1f} MB (up to page {i})")
            writer = PdfWriter()
            current_size = 0

        writer.add_page(page)
        current_size += page_size

    if writer.pages:
        out = io.BytesIO()
        writer.write(out)
        chunks.append(out.getvalue())
        print(f"Chunk {len(chunks)}: {len(chunks[-1]) / 1_000_000:.1f} MB (final)")

    return chunks


def extract_events_from_chunk(gemini_client, chunk_bytes: bytes, retries: int = 3) -> str:
    uploaded_file = gemini_client.files.upload(
        file=io.BytesIO(chunk_bytes),
        config=types.UploadFileConfig(mime_type="application/pdf")
    )

    while uploaded_file.state.name == "PROCESSING":
        time.sleep(2)
        uploaded_file = gemini_client.files.get(name=uploaded_file.name)

    try:
        for attempt in range(retries):
            try:
                response = gemini_client.models.generate_content(
                    model="gemini-flash-lite-latest",
                    contents=[uploaded_file, PROMPT]
                )
                return response.text.strip()
            except Exception as e:
                if attempt < retries - 1 and "503" in str(e):
                    wait = 10 * (attempt + 1)  # 10s, 20s, 30s
                    print(f"503 on attempt {attempt + 1}, retrying in {wait}s...")
                    time.sleep(wait)
                else:
                    raise
    finally:
        gemini_client.files.delete(name=uploaded_file.name)


def collate(texts: list[str]) -> str:
    seen = set()
    lines = []
    for text in texts:
        for line in text.splitlines():
            trimmed = line.strip()
            if trimmed and trimmed != "• No event announcements found." and trimmed not in seen:
                seen.add(trimmed)
                lines.append(trimmed)
    return "\n".join(lines) if lines else "• No event announcements found."


def write_output_file(drive_service, content: str, doc_name: str, folder_id: str) -> str:
    # Write as a plain text file instead of a Google Doc
    media = MediaIoBaseUpload(
        io.BytesIO(content.encode("utf-8")),
        mimetype="text/plain"
    )
    file = drive_service.files().create(
        body={"name": f"{doc_name}.txt", "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True
    ).execute()

    print(f"Written to Drive: {doc_name}.txt (id={file['id']})")
    return file["id"]


if __name__ == "__main__":
    pdf_url, folder_id, base_name = sys.argv[1], sys.argv[2], sys.argv[3]

    # Auth
    creds = Credentials.from_service_account_info(
        json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"]),
        scopes=[
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/documents",
        ]
    )
    drive_service = build("drive", "v3", credentials=creds)
    gemini_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])


    # Fetch and split
    print(f"Fetching: {pdf_url}")
    pdf_bytes = fetch_pdf(pdf_url)
    print(f"Downloaded: {len(pdf_bytes) / 1_000_000:.1f} MB")
    chunks = split_pdf_into_chunks(pdf_bytes, CHUNK_SIZE_BYTES)
    print(f"Split into {len(chunks)} chunks")

    # Extract events from each chunk
    texts = []
    for i, chunk in enumerate(chunks):
        print(f"Processing chunk {i + 1}/{len(chunks)}...")
        text = extract_events_from_chunk(gemini_client, chunk)
        texts.append(text)

    # Collate and write
    combined = collate(texts)
    doc_id = write_output_file(drive_service, combined, base_name, folder_id)

    # Print doc ID so it appears in the workflow logs
    print(f"GOOGLE_DOC_ID={doc_id}")
