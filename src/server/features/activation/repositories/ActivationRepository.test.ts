import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivationRepository } from "./ActivationRepository";

const state = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: drizzle(async (query, params, method) => {
    if (!state.database) throw new Error("Database not initialized");
    const statement = state.database.prepare(query);
    const values = params.map((value: unknown): SQLInputValue => {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "bigint"
      )
        return value;
      throw new Error("Unexpected SQL parameter");
    });
    if (method === "run") {
      statement.run(...values);
      return { rows: [] };
    }
    return { rows: statement.all(...values).map((row) => Object.values(row)) };
  }),
}));

beforeEach(() => {
  state.database?.close();
  state.database = new DatabaseSync(":memory:");
  state.database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE user (id text PRIMARY KEY);
    CREATE TABLE member (id text PRIMARY KEY, organization_id text NOT NULL);
    CREATE TABLE invitation (id text PRIMARY KEY, organization_id text NOT NULL, status text NOT NULL, expires_at integer NOT NULL);
    CREATE TABLE project_activation_state (project_id text PRIMARY KEY, mcp_card_dismissed_at text);
    CREATE TABLE projects (id text PRIMARY KEY, geo_acquisition_mode text);
    INSERT INTO user VALUES ('alice'), ('bob');
    INSERT INTO member VALUES ('member-a', 'org-a');
  `);
  state.database.exec(
    readFileSync("drizzle/0046_plain_the_watchers.sql", "utf8"),
  );
  // **`projects` is hand-written above rather than migrated, and that is the
  // deliberate choice this comment exists to defend.**
  //
  // The obvious alternative — apply `0000`, which creates the table — does not
  // work here: `0000` creates `users` (plural) as well as `projects`, and this
  // harness has a single-person `user` table that the migration's foreign key
  // would not satisfy. So the stub stands, and the stub carries the column
  // `0057` adds, so a positional `INSERT INTO projects VALUES (...)` breaks here
  // exactly as it would in production.
  //
  // `scripts/migration-coverage.test.ts` reports a harness like this as stale,
  // and the report is correct: the table *is* hand-built rather than migrated.
  // The gate cannot tell a lazy harness from one with a reason, so the reason is
  // written down here instead of argued with the gate — which is why `0057` is
  // deliberately **not** applied above: the stub already has the column, and
  // applying it as well fails with `duplicate column name`.
  state.database.exec(`
    INSERT INTO projects (id) VALUES ('project-a'), ('project-b');
  `);
});

describe("checklist persistence", () => {
  it("isolates preferences by person and project and makes dismissal idempotent", async () => {
    await ActivationRepository.setStepDismissed(
      "alice",
      "project-a",
      "project",
      true,
    );
    await ActivationRepository.setStepDismissed(
      "alice",
      "project-a",
      "project",
      true,
    );
    expect(
      await ActivationRepository.getDismissedSteps("alice", "project-a"),
    ).toEqual([{ step: "project" }]);
    expect(
      await ActivationRepository.getDismissedSteps("bob", "project-a"),
    ).toEqual([]);
    expect(
      await ActivationRepository.getDismissedSteps("alice", "project-b"),
    ).toEqual([]);
    await ActivationRepository.setStepDismissed(
      "alice",
      "project-a",
      "project",
      false,
    );
    expect(
      await ActivationRepository.getDismissedSteps("alice", "project-a"),
    ).toEqual([]);
  });
  it("restores legacy MCP dismissals without changing authorization milestones", async () => {
    state.database!.exec(
      "INSERT INTO project_activation_state VALUES ('project-a', '2026-09-05')",
    );
    await ActivationRepository.setStepDismissed(
      "alice",
      "project-a",
      "mcp",
      false,
    );
    expect(
      state
        .database!.prepare(
          "SELECT mcp_card_dismissed_at FROM project_activation_state",
        )
        .get()?.mcp_card_dismissed_at,
    ).toBeNull();
  });
  it("counts only teammates and unexpired pending invitations in this workspace", async () => {
    expect(await ActivationRepository.hasTeammate("org-a")).toBe(false);
    state.database!.exec("INSERT INTO member VALUES ('member-b', 'org-b')");
    state
      .database!.prepare("INSERT INTO invitation VALUES (?, ?, ?, ?)")
      .run("expired", "org-a", "pending", Date.now() - 1000);
    expect(await ActivationRepository.hasTeammate("org-a")).toBe(false);
    state
      .database!.prepare("INSERT INTO invitation VALUES (?, ?, ?, ?)")
      .run("valid", "org-a", "pending", Date.now() + 100000);
    expect(await ActivationRepository.hasTeammate("org-a")).toBe(true);
    expect(await ActivationRepository.hasTeammate("org-b")).toBe(false);
  });
  it("removes preferences when their project or user is deleted", async () => {
    await ActivationRepository.setStepDismissed(
      "alice",
      "project-a",
      "team",
      true,
    );
    await ActivationRepository.setStepDismissed(
      "bob",
      "project-b",
      "domain",
      true,
    );
    state.database!.exec(
      "DELETE FROM user WHERE id = 'alice'; DELETE FROM projects WHERE id = 'project-b'",
    );
    expect(
      state.database!.prepare("SELECT * FROM dashboard_step_dismissals").all(),
    ).toEqual([]);
  });
});
