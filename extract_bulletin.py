import os
import json
import urllib.request
from datetime import date
from pypdf import PdfReader
import gspread
from google.oauth2.service_account import Credentials

# --- Config ---
URL = "https://container.parishesonline.com/bulletins/03/0017/20260412B.pdf"
SHEET_ID = os.environ["SHEET_ID"]

# --- Auth: key is read from env, never touches disk as a file ---
creds_dict = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])
creds = Credentials.from_service_account_info(
    creds_dict,
    scopes=["https://www.googleapis.com/auth/spreadsheets"]
)
client = gspread.authorize(creds)

# --- Download & extract PDF text ---
urllib.request.urlretrieve(URL, "/tmp/bulletin.pdf")
reader = PdfReader("/tmp/bulletin.pdf")
text = "\n".join(page.extract_text() for page in reader.pages)

# --- Write to sheet ---
sheet = client.open_by_key(SHEET_ID).sheet1
sheet.append_row([str(date.today()), text])

print("Done — written to sheet.")
