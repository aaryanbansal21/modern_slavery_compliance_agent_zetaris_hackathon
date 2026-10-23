// Build the processed tables in .data/build from data/demo and data/reference.
import { prepareData } from "../src/data/prepare.ts";

const manifest = prepareData((m) => console.log(m));
console.log(JSON.stringify(manifest, null, 2));
