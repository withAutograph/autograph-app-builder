import inventory from "../evals/scenario-inventory.json" with { type: "json" };

const groups = process.argv.slice(2);
if (
  groups.length === 0 ||
  groups.some((group) => !inventory.some((row) => row.group === group) || group === "retired")
) {
  throw new Error("Select supported scenario inventory groups explicitly.");
}
for (const row of inventory) {
  if (groups.includes(row.group)) {
    process.stdout.write(`${row.id}\n`);
  }
}
