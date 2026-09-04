import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";

async function main() {
  const buf = readFileSync("/tmp/saber_promo.xlsx");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);

  const ws = wb.getWorksheet("SM2 2026")!;
  console.log("rowCount:", ws.rowCount);
  console.log("\nrow 4 all cells:");
  const r4 = ws.getRow(4);
  for (let c = 1; c <= 10; c++) {
    const v = r4.getCell(c).value;
    console.log(`  col ${c}: ${JSON.stringify(v)}  type=${typeof v}`);
  }
  console.log("\nrow 200 all cells:");
  const r200 = ws.getRow(200);
  for (let c = 1; c <= 10; c++) {
    const v = r200.getCell(c).value;
    console.log(`  col ${c}: ${JSON.stringify(v)}  type=${typeof v}`);
  }
  console.log("\nrow 347 all cells:");
  const r347 = ws.getRow(347);
  for (let c = 1; c <= 10; c++) {
    const v = r347.getCell(c).value;
    console.log(`  col ${c}: ${JSON.stringify(v)}  type=${typeof v}`);
  }
  // Test iteration boundaries
  console.log("\niter row 200:");
  ws.getRow(200).eachCell({ includeEmpty: true }, (c, colNumber) => {
    console.log(`  col ${colNumber}: ${JSON.stringify(c.value)}`);
  });
}
main();
