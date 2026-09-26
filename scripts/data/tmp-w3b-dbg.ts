import * as fs from "node:fs/promises";
import { deduplicateAllInMemory, deduplicateStreaming, createDedupAccounting } from "./deduplicate";

async function main(): Promise<void> {
  const root = "/tmp/w3b-dbg1";
  await fs.rm(root, { recursive: true, force: true });
  for (const d of ["in", "ref", "bnd"]) await fs.mkdir(`${root}/${d}`, { recursive: true });
  const src = "/home/ifthenelse/repository/master/maps/data/intermediate";
  const files = (await fs.readdir(src)).filter((n) => n.startsWith("address"));
  for (const f of files) await fs.link(`${src}/${f}`, `${root}/in/${f}`);
  console.log("files", files);
  await deduplicateAllInMemory(`${root}/in`, `${root}/ref`, createDedupAccounting());
  console.log("ref files", await fs.readdir(`${root}/ref`));
  const st = await deduplicateStreaming(`${root}/in`, `${root}/bnd`, createDedupAccounting());
  console.log("bounded", st.emitted, "files", await fs.readdir(`${root}/bnd`));
  for (const n of await fs.readdir(`${root}/bnd`)) console.log(n, (await fs.stat(`${root}/bnd/${n}`)).size);
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
