"""Check the R1 schedule and shared transaction schemas. Requires PyYAML and jsonschema."""
from pathlib import Path
import re
import yaml
from jsonschema import Draft202012Validator

DOCS = Path(__file__).resolve().parents[1]
board = (DOCS / "开发排期与任务台账.md").read_text()
spec = (DOCS / "开发规格.md").read_text()
prd = (DOCS / "QCWarehouse_PRD_v3_MultiCategory.md").read_text()
contract = yaml.safe_load((DOCS / "contracts/core.openapi.yaml").read_text())


def require(condition, message):
    if not condition:
        raise ValueError(message)


tasks = {}
for row in board.splitlines():
    if not row.startswith("| TASK-"):
        continue
    cells = [cell.strip() for cell in row.strip("|").split("|")]
    task = cells[0].split()[0]
    window = re.search(r"E(\d+)–E(\d+)$", cells[0])
    require(window and task not in tasks, f"Invalid task window or duplicate {task}")
    tasks[task] = (int(window[1]), int(window[2]), re.findall(r"TASK-\d+", cells[2]))

previous_end = 0
for task, (start, end, deps) in sorted(tasks.items(), key=lambda pair: pair[1][0]):
    require(start == previous_end + 1 and start <= end, f"Overlap or gap at {task}")
    for dep in deps:
        require(dep in tasks and tasks[dep][1] < start, f"{task} cannot start before {dep}")
    previous_end = end


def unique_ids(pattern, source):
    ids = re.findall(pattern, source, re.MULTILINE)
    require(len(set(ids)) == len(ids), f"Duplicate ID in {pattern}")
    return set(ids)


pages = unique_ids(r"^\| (PAGE-[A-Z]\d+[a-z]?) ·", spec)
tests = unique_ids(r"^\| (T\d+) \|", spec)
gates = unique_ids(r"^\| (AT-\d+) \|", prd)
for row in prd.splitlines():
    if row.startswith("| AT-"):
        owner = re.search(r"(TASK-\d+) / (T\d+) \|$", row)
        require(owner and owner[1] in tasks and owner[2] in tests, f"Unmapped gate: {row}")
for row in spec.splitlines():
    if re.match(r"^\| PAGE-\w+ ·", row):
        refs = re.findall(r"TASK-(\d+)|\bD(\d+)", row.split("|")[-2])
        require(refs and all(f"TASK-{int(a or b):03}" in tasks for a,b in refs), f"Unscheduled page: {row}")
for file in [*DOCS.glob("*.md"), DOCS.parent / "AGENTS.md"]:
    for target in re.findall(r"\]\(([^ )]+)\)", file.read_text()):
        if not target.startswith(("https://", "http://", "#")):
            require((file.parent / target.split("#")[0]).exists(), f"Broken link: {target}")

schemas = contract["components"]["schemas"]


def resolve(node):
    if isinstance(node, list):
        return [resolve(value) for value in node]
    if not isinstance(node, dict):
        return node
    if "$ref" in node:
        name = node["$ref"].removeprefix("#/components/schemas/")
        return resolve(schemas[name])
    return {key: resolve(value) for key, value in node.items()}


ops = set()
for path, methods in contract["paths"].items():
    for op in methods.values():
        name = op["operationId"]
        require(name not in ops and op["x-roles"], f"Invalid operation: {name}")
        ops.add(name)
        params = {p["name"] for p in op["parameters"] if p["in"] == "path" and p["required"]}
        require(params == set(re.findall(r"{(\w+)}", path)), f"Invalid parameters: {path}")
        for entry in [op.get("requestBody", {}), *op["responses"].values()]:
            for media in entry.get("content", {}).values():
                Draft202012Validator.check_schema(resolve(media["schema"]))

result = Draft202012Validator(resolve(schemas["Result"]))
base = {"component":"main","item_key":"width","method":"ruler","attempt":1,"is_final":True}
require(result.is_valid(dict(base,status="RECORDED",typed_value=0)), "Measured zero lost")
require(not result.is_valid(dict(base,status="RECORDED")), "Missing value accepted")
require(not result.is_valid(dict(base,status="NOT_TESTED",reason="Unavailable",typed_value=0)), "Missing measurement became zero")
entry = contract["paths"]["/me/items/{id}/dispositions"]["post"]["requestBody"]["content"]["application/json"]["schema"]
instruction = Draft202012Validator(resolve(entry))
request = {"action":"return_to_seller","terms_version_id":"00000000-0000-4000-8000-000000000001",
           "destination":{"recipient":"Seller","phone":"test","address":"Test destination"}}
require(not instruction.is_valid(request), "Return without customer confirmation accepted")
request["return_info"] = {"requested_from_seller":True,"customer_pays_shipping":True}
require(instruction.is_valid(request), "Valid return without outbound number rejected")
print(f"{len(tasks)} tasks, E1–E{previous_end}, {len(pages)} pages, {len(tests)} implementation cases, "
      f"{len(gates)} product gates, {len(ops)} transaction operations")
