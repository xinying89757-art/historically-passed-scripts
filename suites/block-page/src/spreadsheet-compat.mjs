import { readFile, writeFile } from "node:fs/promises";
import * as XLSX from "xlsx";

function columnNumber(value) {
  let result = 0;
  for (const character of value.toUpperCase()) result = result * 26 + character.charCodeAt(0) - 64;
  return result - 1;
}

function parseCell(value) {
  const match = String(value).match(/^([A-Z]+)(\d+)$/iu);
  if (!match) throw new Error(`不支持的 Excel 单元格地址：${value}`);
  return { row: Number(match[2]) - 1, column: columnNumber(match[1]) };
}

function parseRange(address) {
  const parts = String(address).split(":");
  const start = parseCell(parts[0]);
  const end = parseCell(parts[1] ?? parts[0]);
  return {
    row: start.row,
    column: start.column,
    rowCount: end.row - start.row + 1,
    columnCount: end.column - start.column + 1,
  };
}

function emptyFormat() {
  return {
    autofitColumns() {},
    autofitRows() {},
  };
}

class Range {
  constructor(sheet, bounds) {
    this.sheet = sheet;
    this.bounds = bounds;
    this._format = emptyFormat();
  }

  get values() {
    return Array.from({ length: this.bounds.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.bounds.columnCount }, (_, columnOffset) =>
        this.sheet.valueAt(this.bounds.row + rowOffset, this.bounds.column + columnOffset)));
  }

  set values(matrix) {
    for (let rowOffset = 0; rowOffset < this.bounds.rowCount; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.bounds.columnCount; columnOffset += 1) {
        this.sheet.setValueAt(this.bounds.row + rowOffset, this.bounds.column + columnOffset, matrix[rowOffset]?.[columnOffset] ?? "");
      }
    }
  }

  get format() {
    return this._format;
  }

  set format(value) {
    this._format = { ...this._format, ...(value ?? {}) };
    if (typeof this._format.autofitColumns !== "function") this._format.autofitColumns = emptyFormat().autofitColumns;
    if (typeof this._format.autofitRows !== "function") this._format.autofitRows = emptyFormat().autofitRows;
  }
}

class Worksheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((row) => [...row]);
    this.isNullObject = false;
    this.freezePanes = { freezeRows() {} };
  }

  valueAt(row, column) {
    return this.rows[row]?.[column] ?? "";
  }

  setValueAt(row, column, value) {
    while (this.rows.length <= row) this.rows.push([]);
    while (this.rows[row].length <= column) this.rows[row].push("");
    this.rows[row][column] = value;
  }

  getRange(address) {
    return new Range(this, parseRange(address));
  }

  getRangeByIndexes(row, column, rowCount, columnCount) {
    return new Range(this, { row, column, rowCount, columnCount });
  }

  getUsedRange() {
    const rowCount = Math.max(this.rows.length, 1);
    const columnCount = Math.max(this.rows.reduce((max, row) => Math.max(max, row.length), 0), 1);
    return new Range(this, { row: 0, column: 0, rowCount, columnCount });
  }
}

class WorksheetCollection {
  constructor(items = []) {
    this.items = items;
  }

  getItem(name) {
    return this.items.find((sheet) => sheet.name === name) ?? { isNullObject: true };
  }

  add(name) {
    const sheet = new Worksheet(name);
    this.items.push(sheet);
    return sheet;
  }
}

class Workbook {
  constructor(sheets = []) {
    this.worksheets = new WorksheetCollection(sheets);
  }

  static create() {
    return new Workbook();
  }
}

export const FileBlob = {
  async load(filePath) {
    return readFile(filePath);
  },
};

export const SpreadsheetFile = {
  async importXlsx(bytes) {
    const source = XLSX.read(bytes, { type: "buffer", cellDates: false });
    const sheets = source.SheetNames.map((name) => new Worksheet(name, XLSX.utils.sheet_to_json(source.Sheets[name], { header: 1, defval: "" })));
    return new Workbook(sheets);
  },

  async exportXlsx(workbook) {
    return {
      async save(filePath) {
        const output = XLSX.utils.book_new();
        for (const sheet of workbook.worksheets.items) {
          XLSX.utils.book_append_sheet(output, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name.slice(0, 31));
        }
        const buffer = XLSX.write(output, { bookType: "xlsx", type: "buffer" });
        await writeFile(filePath, buffer);
      },
    };
  },
};

export { Workbook };
