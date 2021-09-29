/**
 * This program updates src/conf/xlsx/column-and-parameter-descriptions.xlsx for show/hide
 * properties of search parameters, depending on whether server has data.
 * When server data might have updated, run:
 *     node update-excel-configurations.js
 *     npm run build
 * and check in configuration file changes.
 */
const reader = require('xlsx');
const fs = require('fs');
const https = require('https');
const writeXlsxFile = require('write-excel-file/node');

const SERVICEBASEURL = '---SERVICE BASE URL:';
const SEARCHPARAMETER = 'search parameter';
const filePath = 'src/conf/xlsx/column-and-parameter-descriptions.xlsx';
const file = reader.readFile(filePath, { cellStyles: true });
const xlsxColumnHeaders = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

/**
 * Constructs data of a sheet row to be used by write-excel-file library.
 * @param sheet WorkSheet object
 * @param rowNum current row number in the sheet
 * @param columnCount total number of columns
 */
function getRowData(sheet, rowNum, columnCount) {
  const row = [];
  for (let i = 0; i < columnCount; i++) {
    const cell = sheet[`${xlsxColumnHeaders[i]}${rowNum}`];
    if (!cell) {
      row.push({ value: '' });
    } else if (cell.s.fgColor) {
      row.push({ value: cell.v, backgroundColor: `#${cell.s.fgColor.rgb}` });
    } else {
      row.push({ value: cell.v });
    }
  }
  return row;
}

/**
 * Creates a promise that will resolve after trying to query server with the search parameter.
 * Updates sheet object for show/hide column.
 * @param url server query to determine if the search parameter has value
 * @param resourceType resource type
 * @param rowNum row number
 * @param sheet WorkSheet object
 */
function createHttpsPromise(url, resourceType, rowNum, sheet) {
  console.log(url);
  return new Promise((resolve, _) => {
    https.get(url, (res) => {
      const { statusCode } = res;
      if (statusCode < 200 || statusCode >= 300) {
        console.error(
          `Hide! ${resourceType} ${
            sheet[`B${rowNum}`].v
          } - HTTPS failed with code ${statusCode}`
        );
        sheet[`E${rowNum}`].v = 'hide';
        resolve();
        return;
      }
      res.setEncoding('utf8');
      let rawData = '';
      res.on('data', (chunk) => {
        rawData += chunk;
      });
      res.on('end', () => {
        const parsedData = JSON.parse(rawData);
        if (parsedData.entry && parsedData.entry.length > 0) {
          console.log(`Show! ${resourceType} ${sheet[`B${rowNum}`].v}`);
          sheet[`E${rowNum}`].v = 'show';
          resolve();
        } else {
          console.log(`Hide! ${resourceType} ${sheet[`B${rowNum}`].v}`);
          sheet[`E${rowNum}`].v = 'hide';
          resolve();
        }
      });
    });
  });
}

fs.unlinkSync(filePath);
const httpPromises = [];
// Update sheets to hide search parameters that don't have data on the corresponding server.
for (let i = 0; i < file.SheetNames.length; i++) {
  const sheet = file.Sheets[file.SheetNames[i]];
  let serviceBaseUrl = '';
  let resourceType;
  // sheet['!ref'] returns the sheet range as in format 'A1:H100'.
  const maxRowNumber = sheet['!ref'].slice(4);
  for (let rowNum = 1; rowNum <= maxRowNumber; rowNum++) {
    if (sheet[`A${rowNum}`]?.v) {
      resourceType = sheet[`A${rowNum}`]?.v;
      if (sheet[`A${rowNum}`]?.v === SERVICEBASEURL) {
        serviceBaseUrl = sheet[`B${rowNum}`]?.v;
        // Do not update default sheet.
        if (serviceBaseUrl === 'default') {
          break;
        }
      }
    }
    if (sheet[`C${rowNum}`]?.v === SEARCHPARAMETER) {
      const paramName = sheet[`B${rowNum}`].v;
      const paramType = sheet[`F${rowNum}`].v;
      const url =
        paramType === 'date' || paramType === 'dateTime'
          ? `${serviceBaseUrl}/${resourceType}?_count=1&_type=json&${paramName}=gt1000-01-01`
          : `${serviceBaseUrl}/${resourceType}?_count=1&_type=json&${paramName}:not=zzz`;
      const promise = createHttpsPromise(url, resourceType, rowNum, sheet);
      httpPromises.push(promise);
    }
  }
}

Promise.all(httpPromises).then(() => {
  const sheetsData = [];
  for (let i = 0; i < file.SheetNames.length; i++) {
    const sheet = file.Sheets[file.SheetNames[i]];
    const maxRowNumber = sheet['!ref'].slice(4);
    const maxColumnLetter = sheet['!ref'].charAt(3);
    const columnCount =
      xlsxColumnHeaders.findIndex((x) => x === maxColumnLetter) + 1;
    const sheetData = [];
    for (let rowNum = 1; rowNum <= maxRowNumber; rowNum++) {
      sheetData.push(getRowData(sheet, rowNum, columnCount));
    }
    sheetsData.push(sheetData);
  }
  // Writing with column width data from 1st sheet, since you can only pass in one column width array.
  const columns = file.Sheets[file.SheetNames[0]]['!cols'];
  writeXlsxFile(sheetsData, {
    sheets: file.SheetNames,
    columns,
    filePath
  });
});
