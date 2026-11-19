// Loaded with import() by document-extraction.ts so SheetJS is evaluated on the first spreadsheet
// import instead of at Edge isolate startup. Named re-exports (rather than import() of the package)
// keep the bundler's tree-shaking.
export { read, utils } from "xlsx";
