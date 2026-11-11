import { readFileSync } from "node:fs";
import { admitRouting } from "../../src/routing-state.ts";
import type { RoutingRecord } from "../../src/routing-types.ts";

const route = JSON.parse(readFileSync(process.argv[3], "utf8")) as RoutingRecord;
admitRouting(process.argv[2], route, () => {});
process.stdout.write(JSON.stringify({ turn: route.tieTurn, model: route.selected }));
