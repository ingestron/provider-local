/** Core supplies bounded compilation columns; the source verifies complete indexed documents. */
export function validateMetadataProjection(input, tables) {
  const index = input.tableDocuments;
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const keys = (value, expected) =>
    object(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
  if (
    Object.hasOwn(input, "tables") ||
    Object.hasOwn(input, "selection") ||
    !keys(index, ["apiVersion", "kind", "documents", "totalBytes"]) ||
    index.apiVersion !== "ingestron.metadata-documents/v1" ||
    index.kind !== "project" ||
    !object(index.documents) ||
    !object(tables)
  )
    throw Error("Invalid indexed connection metadata");
  const names = Object.keys(index.documents);
  if (
    !names.length ||
    names.length > 100 ||
    Object.keys(tables).length !== names.length
  )
    throw Error("Invalid indexed connection metadata");
  let bytes = 0;
  for (const name of names) {
    const record = index.documents[name],
      table = tables[name];
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]{0,100}$/.test(name) ||
      !Object.hasOwn(tables, name) ||
      !keys(record, ["path", "sha256", "bytes"]) ||
      !/^[a-f0-9]{64}$/.test(record.sha256) ||
      record.path !== `metadata/project/${record.sha256}.json` ||
      !Number.isInteger(record.bytes) ||
      record.bytes < 1 ||
      record.bytes > 2_000_000 ||
      !object(table) ||
      Object.keys(table).some(
        (key) => !["source", "columns", "contract"].includes(key),
      ) ||
      !object(table.source) ||
      !Array.isArray(table.columns) ||
      table.columns.length > 500 ||
      (Object.hasOwn(table, "contract")
        ? table.contract !== true || !table.columns.length
        : table.columns.length !== 0)
    )
      throw Error("Invalid indexed connection metadata");
    bytes += record.bytes;
  }
  if (bytes > 7_000_000 || index.totalBytes !== bytes)
    throw Error("Indexed metadata exceeds its collection bounds");
}
