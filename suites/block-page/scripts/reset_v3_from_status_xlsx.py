#!/usr/bin/env python3
"""Requeue only records whose status is 上线 in block-status-summary.xlsx.

This is intentionally a state-preparation step. The normal Playwright runner
still performs all editor writes, page saves, and reopen verification.
"""
from __future__ import annotations

import argparse
import json
import shutil
import time
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET


NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def read_status_rows(workbook: Path) -> list[dict[str, str]]:
    with ZipFile(workbook) as archive:
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))

    rows: list[tuple[int, list[str]]] = []
    for row in sheet.findall(".//m:sheetData/m:row", NS):
        values: list[str] = []
        for cell in row.findall("m:c", NS):
            value = cell.find("m:v", NS)
            values.append("" if value is None else (value.text or ""))
        rows.append((int(row.attrib["r"]), values))

    header_row, headers = next((item for item in rows if item[1] and item[1][0] == "block_id"), (0, []))
    if not header_row or headers[:4] != ["block_id", "区块名称", "状态", "第三个操作"]:
        raise ValueError("工作簿缺少预期的区块状态表头")

    records = []
    for row_number, values in rows:
        if row_number <= header_row or len(values) < 4:
            continue
        row = dict(zip(headers[:4], values[:4]))
        if row.get("block_id") and row.get("状态") == "上线":
            records.append(row)
    return records


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workbook", required=False, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--manifest", required=False, type=Path)
    parser.add_argument("--requeue-batch", required=False, help="只重新排队该上线批次中尚未成功的失败记录")
    args = parser.parse_args()

    if args.requeue_batch:
        state = json.loads(args.state.read_text(encoding="utf-8"))
        if state.get("online_retry", {}).get("batch_id") != args.requeue_batch:
            raise ValueError("状态文件中的上线批次与 --requeue-batch 不一致")
        reset_statuses = {"not_found", "add_failed", "render_failed", "save_failed", "existing_mapping_missing"}
        reset = []
        for record in state["records"]:
            if record.get("online_retry_batch") != args.requeue_batch or record.get("status") not in reset_statuses:
                continue
            reset.append(record["block_id"])
            record.update({
                "page_name": "",
                "page_url": "",
                "slot_index": "",
                "editor_dom_id": "",
                "status": "pending",
                "placement_origin": "",
                "source_status": "",
                "saved_at": "",
                "audit": None,
                "failure_reason": "",
                "heading_status": "pending",
                "heading_failure_reason": "",
                "heading_results": [],
                "heading_poc": [],
                "heading_verified_at": "",
            })
        state["online_retry"]["last_requeue"] = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "count": len(reset), "block_ids": reset}
        args.state.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"batch_id": args.requeue_batch, "requeued": len(reset), "block_ids": reset}, ensure_ascii=False))
        return

    if not args.workbook or not args.manifest:
        raise ValueError("首次准备需要同时提供 --workbook 和 --manifest")

    online = read_status_rows(args.workbook)
    online_by_id = {str(row["block_id"]).strip(): row for row in online}
    if len(online_by_id) != len(online):
        raise ValueError("上线清单存在重复 block_id，拒绝写入")

    state = json.loads(args.state.read_text(encoding="utf-8"))
    records_by_id = {str(record["block_id"]): record for record in state["records"]}
    missing = sorted(set(online_by_id) - set(records_by_id))
    if missing:
        raise ValueError(f"上线清单中的 block_id 不在当前状态中：{','.join(missing)}")

    batch_id = time.strftime("online-retry-%Y%m%d-%H%M%S")
    backup = args.state.with_name(args.state.name + f".before-{batch_id}.bak")
    shutil.copy2(args.state, backup)

    previous = []
    for block_id in online_by_id:
        record = records_by_id[block_id]
        previous.append({
            "block_id": block_id,
            "status": record.get("status", ""),
            "heading_status": record.get("heading_status", ""),
            "page_name": record.get("page_name", ""),
            "page_url": record.get("page_url", ""),
            "failure_reason": record.get("failure_reason", ""),
            "heading_failure_reason": record.get("heading_failure_reason", ""),
        })
        record.update({
            "page_name": "",
            "page_url": "",
            "slot_index": "",
            "editor_dom_id": "",
            "status": "pending",
            "placement_origin": "",
            "source_status": "",
            "saved_at": "",
            "audit": None,
            "failure_reason": "",
            "heading_status": "pending",
            "heading_failure_reason": "",
            "heading_results": [],
            "heading_poc": [],
            "heading_verified_at": "",
            "online_retry_batch": batch_id,
        })

    state["current_page"] = None
    state["online_retry"] = {
        "batch_id": batch_id,
        "workbook": str(args.workbook),
        "status": "上线",
        "record_count": len(online_by_id),
        "backup": str(backup),
        "block_ids": list(online_by_id),
        "previous": previous,
    }
    args.state.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps({
        "batch_id": batch_id,
        "workbook": str(args.workbook),
        "status": "上线",
        "record_count": len(online_by_id),
        "backup": str(backup),
        "records": previous,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"batch_id": batch_id, "count": len(online_by_id), "backup": str(backup), "manifest": str(args.manifest)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
