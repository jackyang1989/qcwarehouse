import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { parse } from "yaml";

type Operation = {
  operationId: string;
  responses: Record<string, { content: { "application/json": { schema: object } } }>;
};

const contract = parse(readFileSync("docs/contracts/core.openapi.yaml", "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: object;
};
const schemaId = "https://qcwarehouse.invalid/test/core";
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: schemaId, components: contract.components });

function compile(schema: object) {
  const expanded = JSON.stringify(schema).replaceAll('"#/components/schemas/', '"' + schemaId + "#/components/schemas/");
  return ajv.compile(JSON.parse(expanded));
}

const operations = Object.entries(contract.paths).flatMap(([path, methods]) =>
  Object.entries(methods).map(([method, op]) => {
    const status = Object.keys(op.responses).find(code => /^2\d\d$/.test(code));
    assert(status, "Missing successful response for " + op.operationId);
    return {
      method: method.toUpperCase(),
      path: new RegExp("^" + path.replace(/\{[^}]+\}/g, "[^/]+") + "$"),
      id: op.operationId,
      status: Number(status),
      success: compile(op.responses[status].content["application/json"].schema),
      error: compile(op.responses.default.content["application/json"].schema),
    };
  })
);

const covered = new Set<string>();

export function assertCoreResponse(method: string, path: string, status: number, body: unknown) {
  const operation = operations.find(op => op.method === method && op.path.test(path.split("?")[0]));
  if (!operation) return;
  if (status >= 400) {
    assert(operation.error(body), operation.id + " error DTO " + ajv.errorsText(operation.error.errors));
    return;
  }
  assert.equal(status, operation.status, operation.id);
  assert(operation.success(body), operation.id + " success DTO " + ajv.errorsText(operation.success.errors));
  covered.add(operation.id);
}

export function assertCoreCoverage() {
  const missing = operations.filter(op => !covered.has(op.id)).map(op => op.id);
  assert.deepEqual(missing, [], "Core operations without a successful fixture response");
}
