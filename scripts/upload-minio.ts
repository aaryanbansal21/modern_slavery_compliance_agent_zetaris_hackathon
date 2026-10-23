// Upload the reference lists to S3-compatible object storage (MinIO locally,
// or AWS S3). Each table gets its own folder, which Zetaris registers as a
// Lightning filestore table: s3a://<bucket>/<table>/
//   npm run upload:minio
import path from "node:path";
import * as Minio from "minio";
import { config } from "../src/config.ts";
import { buildDir, prepareData } from "../src/data/prepare.ts";
import { TABLES } from "../src/data/schema.ts";

prepareData((m) => console.log(m));
const client = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});
const bucket = config.minio.bucket;
if (!(await client.bucketExists(bucket).catch(() => false))) {
  await client.makeBucket(bucket);
  console.log(`Created bucket ${bucket}`);
}
for (const t of TABLES.filter((x) => x.group === "rs_ref")) {
  const object = `${t.table}/${t.table}.csv`;
  await client.fPutObject(bucket, object, path.join(buildDir(), t.file), { "Content-Type": "text/csv" });
  console.log(`  s3://${bucket}/${object}`);
}
console.log("Reference lists uploaded. Next: npm run zetaris:setup");
