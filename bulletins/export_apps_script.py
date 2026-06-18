import json
import os
import sys
import time
from pathlib import Path

from google.oauth2.service_account import Credentials
from googleapiclient.errors import HttpError
from googleapiclient.discovery import build


SCOPES = [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/script.projects.readonly",
]
SCRIPT_SERVICE = "script.googleapis.com"


def _http_error_reason(error: HttpError) -> str | None:
    try:
        payload = json.loads(error.content.decode("utf-8"))
    except Exception:
        return None

    for detail in payload.get("error", {}).get("details", []):
        reason = detail.get("reason")
        if reason:
            return reason
    return None


def _wait_for_operation(service, operation_name: str) -> None:
    for _ in range(30):
        operation = service.operations().get(name=operation_name).execute()
        if operation.get("done"):
            if "error" in operation:
                raise RuntimeError(json.dumps(operation["error"], indent=2))
            return
        time.sleep(2)
    raise TimeoutError(f"Timed out waiting for operation {operation_name}")


def _enable_apps_script_api(creds: Credentials, project_id: str) -> None:
    serviceusage = build("serviceusage", "v1", credentials=creds)
    service_name = f"projects/{project_id}/services/{SCRIPT_SERVICE}"
    operation = serviceusage.services().enable(name=service_name).execute()
    operation_name = operation.get("name")
    if operation_name:
        _wait_for_operation(serviceusage, operation_name)


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: export_apps_script.py SCRIPT_ID OUTPUT_PATH", file=sys.stderr)
        return 2

    script_id = sys.argv[1]
    output_path = Path(sys.argv[2])
    service_account_info = json.loads(os.environ["GOOGLE_SERVICE_ACCOUNT_JSON"])

    creds = Credentials.from_service_account_info(
        service_account_info,
        scopes=SCOPES,
    )
    service = build("script", "v1", credentials=creds)

    try:
        project = service.projects().get(scriptId=script_id).execute()
    except HttpError as error:
        if error.resp.status != 403 or _http_error_reason(error) != "SERVICE_DISABLED":
            raise
        project_id = service_account_info["project_id"]
        print(f"Apps Script API is disabled for {project_id}; attempting to enable it.")
        _enable_apps_script_api(creds, project_id)
        print("Apps Script API enabled; retrying export.")
        project = service.projects().get(scriptId=script_id).execute()

    content = service.projects().getContent(scriptId=script_id).execute()

    result = {
        "project": project,
        "content": content,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")

    files = content.get("files", [])
    print(f"Exported Apps Script project: {project.get('title', script_id)}")
    print(f"File count: {len(files)}")
    for file in files:
        source = file.get("source", "")
        print(f"- {file.get('name')} ({file.get('type')}): {len(source)} chars")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
