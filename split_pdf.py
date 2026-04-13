import io
import sys
import urllib.request
from pypdf import PdfReader, PdfWriter


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


if __name__ == "__main__":
    url = sys.argv[1]
    print(f"Fetching: {url}")

    pdf_bytes = fetch_pdf(url)
    print(f"Downloaded: {len(pdf_bytes) / 1_000_000:.1f} MB")

    part1, part2 = split_pdf(pdf_bytes)
    print(f"Part 1: {len(part1) / 1_000_000:.1f} MB")
    print(f"Part 2: {len(part2) / 1_000_000:.1f} MB")

    with open("part1.pdf", "wb") as f:
        f.write(part1)
    with open("part2.pdf", "wb") as f:
        f.write(part2)

    print("Done — part1.pdf and part2.pdf written.")
