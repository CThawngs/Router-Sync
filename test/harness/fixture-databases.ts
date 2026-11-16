/**
 * test/harness/fixture-databases.ts
 *
 * AT-155 (R19-1) — writes a real-router-shaped set of combos into the
 * THROWAWAY databases the daemon harness hands over.
 *
 * The databases live under `os.tmpdir()` and are deleted with the fixture; a
 * real router DB is never opened, read or written.
 *
 * ponytail: AT-148 keeps its own copy of this helper, because AT-148 is the
 * frozen baseline of the mutation `r19-mut-interactive-claim` (it must stay
 * byte-identical). Merge the two copies when AT-148 is allowed to change.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
};

/** A combo with many models, so the ladder has more steps than fit. */
const BIG_MODELS = Array.from(
  { length: 60 },
  (_, i) => `m${String(i + 1).padStart(2, "0")}`,
);
const SMALL_MODELS = ["m59", "m60", "m61"];
const OMNI_MODELS = ["omni-only-model"];

/** What a shaped fixture carries. */
export interface FixtureShape {
  omniDbPath: string;
  nineDbPath: string;
}

/**
 * Writes the fixture combos into the throwaway databases.
 *
 * Same pattern as at-145-daemon-ui-roundtrip.test.tsx.
 */
export function shapeFixtureDatabases(target: FixtureShape): void {
  const nineDb = new DatabaseSync(target.nineDbPath);
  try {
    nineDb.exec(`DELETE FROM combos;`);
    const now = new Date().toISOString();
    const insert = nineDb.prepare(
      `INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "routersync-big",
      "Big Combo",
      "managed",
      JSON.stringify(BIG_MODELS),
      now,
      now,
    );
    insert.run(
      "routersync-small",
      "Small Combo",
      "custom",
      JSON.stringify(SMALL_MODELS),
      now,
      now,
    );
    nineDb.prepare("UPDATE settings SET data = ? WHERE id = 1").run(
      JSON.stringify({
        theme: "dark",
        port: 20128,
        comboStrategies: {
          "Big Combo": "priority",
          "Small Combo": { fallbackStrategy: "fallback" },
        },
      }),
    );
  } finally {
    nineDb.close();
  }

  const omniDb = new DatabaseSync(target.omniDbPath);
  try {
    omniDb.exec(`DELETE FROM combos;`);
    omniDb.exec(
      `INSERT INTO combos (id, name, data) VALUES ('routersync-omni', 'Omni Combo', ` +
        `'{"strategy":"priority","models":${JSON.stringify(JSON.stringify(OMNI_MODELS))},"managed":true}');`,
    );
  } finally {
    omniDb.close();
  }
}
