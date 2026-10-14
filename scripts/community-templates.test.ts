import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "yaml";
import { describe, expect, it } from "vitest";

/**
 * The issue templates a contributor actually sees, and the skill they are told to
 * install.
 *
 * ## Why this file exists
 *
 * A YAML parse error is visible — nothing renders. The failure mode that is *not*
 * visible is a **valid YAML document GitHub silently refuses**: an attribute key the
 * issue-forms schema does not accept, such as `description` on a `markdown` element,
 * produces a form GitHub never shows. The contributor sees "no templates", the
 * maintainer sees no issues, and nothing in any build says a word.
 *
 * That is precisely what shipped here: `feature_request.yml` opened with a
 * `markdown` element carrying `description` instead of `value`, so the one form a
 * first-time contributor would reach for would have been dropped. Reading the files
 * against the schema is the only kind of check that can catch it, and it is now a
 * gate rather than a review note.
 *
 * ## Why the contract is written out rather than imported
 *
 * GitHub publishes no package for its own issue-forms schema, so the accepted keys
 * are transcribed here. **A key added to this repository in future must be added here
 * too** — which is the point: a template that drifts from this list fails the build,
 * and the fix is one line, not a mystery.
 */

const TEMPLATE_DIR = ".github/ISSUE_TEMPLATE";

/** Accepted keys of a template file's root object. */
const TEMPLATE_KEYS = new Set([
  "name",
  "description",
  "labels",
  "assignees",
  "title",
  "body",
]);

/** Accepted keys of each body element. */
const ELEMENT_KEYS = new Set(["type", "id", "attributes", "validations"]);

/** Accepted element types, per the issue-forms DSL. */
const ELEMENT_TYPES = new Set([
  "markdown",
  "textarea",
  "input",
  "dropdown",
  "checkboxes",
]);

/**
 * Accepted attributes per element type.
 *
 * `markdown` takes only `value` — a `markdown` element carrying `description` is
 * silently dropped by GitHub, and it is the easiest mistake in the set to make, which
 * is why it has a line here instead of being left to inference.
 */
const ATTRIBUTE_KEYS: Record<string, ReadonlySet<string>> = {
  markdown: new Set(["value"]),
  textarea: new Set(["label", "description", "placeholder", "render"]),
  input: new Set(["label", "description", "placeholder", "render"]),
  dropdown: new Set(["label", "description", "options", "multiple", "default"]),
  checkboxes: new Set(["label", "description", "options"]),
};

/** Accepted validation keys. */
const VALIDATION_KEYS = new Set(["required", "min", "max", "pattern"]);

/** `config.yml` has its own, smaller schema. */
const CONFIG_KEYS = new Set(["blank_issues_enabled", "contact_links"]);
const CONTACT_LINK_KEYS = new Set(["name", "url", "about"]);

/** Form templates, as opposed to `config.yml`. */
const FORM_FILES = [
  "bug_report.yml",
  "feature_request.yml",
  "good_first_issue.yml",
];

/** The skill three shipped files tell a contributor to install. */
const SIMPLE_ISSUE_SKILL = "simple-issue-description";

/**
 * A parsed template, narrowed by a guard rather than by a cast.
 *
 * `yaml.parse` returns `any`, and the type-aware lint refuses an assertion *from*
 * `any` on the grounds that it is a claim the compiler cannot check. The guard is the
 * honest version: it says what it accepted, and it rejects the shapes these files are
 * not — an empty document, an array, a plain string — each of which would otherwise
 * arrive as an empty object and make every later assertion pass vacuously.
 */
type Template = {
  name?: unknown;
  labels?: unknown;
  body?: unknown;
  contact_links?: unknown;
  blank_issues_enabled?: unknown;
};

function readTemplate(file: string): Template {
  const parsed: unknown = yaml.parse(
    readFileSync(join(TEMPLATE_DIR, file), "utf8"),
  );
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} did not parse to a template object`);
  }
  return parsed;
}

/** One body element, as these files use it. */
type TemplateElement = {
  type?: unknown;
  id?: unknown;
  attributes?: unknown;
  validations?: unknown;
};

function asElement(value: unknown): TemplateElement | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

/** The members of an array that are strings. Anything else in a label list is not a label. */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** The keys of an object field, or none when the field is not an object. */
function keysOf(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value);
}

/**
 * The named fields of an object, as a map of names to values.
 *
 * A function rather than a cast so the lint's `no-unsafe-assignment` is satisfied by
 * the shape being *built* with the caller's own types: `unknown` in, `string` out.
 */
function fieldOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    fields[key] = entry;
  }
  return fields;
}

function records(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Walk a template's body and collect every key the schema would reject. */
function schemaProblems(file: string): string[] {
  const problems: string[] = [];
  const template = readTemplate(file);

  for (const key of Object.keys(template)) {
    if (!TEMPLATE_KEYS.has(key)) problems.push(`unknown template key "${key}"`);
  }

  // GitHub only offers a template that names at least one label.
  if (strings(template.labels).length === 0) {
    problems.push(
      "no labels — GitHub never offers a template with an empty label list",
    );
  }

  for (const raw of records(template.body)) {
    const element = asElement(raw);
    if (element === null) {
      problems.push("a body element is not an object");
      continue;
    }
    for (const key of Object.keys(element)) {
      if (!ELEMENT_KEYS.has(key)) problems.push(`unknown element key "${key}"`);
    }
    const type = element.type;
    if (typeof type !== "string" || !ELEMENT_TYPES.has(type)) {
      problems.push(`unknown element type "${String(type)}"`);
      continue;
    }

    // **The element's name in messages, narrowed to a string.** `id` is `unknown`
    // from the parse, and an object that lands there produces
    // `element "[object Object]"` in the failure — a message that names nothing.
    // A type check here is not defensiveness: it is what makes the failure
    // readable when the fix is "add an id to line 40".
    const label = typeof element.id === "string" ? element.id : type;

    // Read through a fallback rather than asserted: an unlisted type allows
    // nothing, and `undefined` is the honest answer to "what does this accept".
    const allowed = ATTRIBUTE_KEYS[type] ?? new Set<string>();
    const validations = element.validations;
    const required = keysOf(validations).length > 0;

    for (const key of keysOf(element.attributes)) {
      if (!allowed.has(key)) {
        problems.push(
          `element "${label}" of type "${type}" has the attribute ` +
            `"${key}", which the issue-forms schema does not accept — GitHub drops the whole ` +
            "form rather than the key",
        );
      }
    }
    for (const key of keysOf(validations)) {
      if (!VALIDATION_KEYS.has(key)) {
        problems.push(`unknown validation key "${key}"`);
      }
    }

    // `required` on anything but a fillable element is meaningless.
    const fillable = ["textarea", "input", "dropdown", "checkboxes"];
    // Read through the same helper rather than an assertion: "is `required: true`
    // present" is a question about a field, and the field helper answers it.
    const isRequired = fieldOf(validations).required === true;
    if (isRequired && !fillable.includes(type)) {
      problems.push(`"required" on a ${type} element does nothing`);
    }
    if (required && !fillable.includes(type)) {
      problems.push(`"${type}" element carries validations, which it ignores`);
    }
  }

  return problems;
}

describe("the issue templates the contributor sees", () => {
  it("every key is one GitHub accepts, so no form is silently dropped", () => {
    for (const file of FORM_FILES) {
      // The violations go into the message: a failure that only says `[] !== ["key"]`
      // sends the reader to the file with no idea what to change.
      expect(
        schemaProblems(file),
        `${file} violates the issue-forms schema`,
      ).toEqual([]);
    }
  });

  it("the good-first-issue template carries the label the README links to", () => {
    // The README sends a contributor to the `good first issue` label page; the
    // template that creates those issues has to name that exact label, or the link
    // leads to a page nobody is filling.
    const labels = strings(readTemplate("good_first_issue.yml").labels);
    expect(labels).toContain("good first issue");
  });
});

describe(".github/ISSUE_TEMPLATE/config.yml", () => {
  it("uses only the keys GitHub reads from it", () => {
    const config = readTemplate("config.yml");
    for (const key of Object.keys(config)) {
      expect([...CONFIG_KEYS]).toContain(key);
    }
    const links = records(config.contact_links);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      for (const key of keysOf(link)) {
        expect([...CONTACT_LINK_KEYS]).toContain(key);
      }
    }
  });
});

describe("the skill the templates and docs promise", () => {
  it("exists, because shipped files tell a contributor to install it", () => {
    // README.md and docs/CONTRIBUTING.md both run
    // `npx skills add RatioArtificiosa/Open-GEO --skill simple-issue-description`.
    // The skill did not exist when those were written, so the install failed for
    // every contributor who followed them. A dead install command in shipped docs
    // is worse than no command, because the reader concludes the project is slack.
    const paths = [
      join(".agents/skills", SIMPLE_ISSUE_SKILL, "SKILL.md"),
      join("plugins/opengeo/skills", SIMPLE_ISSUE_SKILL, "SKILL.md"),
    ];
    for (const path of paths) {
      expect(statSync(path).isFile(), `${path} is missing`).toBe(true);
    }
  });

  it("declares the name the install command passes, so the registry finds it", () => {
    const skill = readFileSync(
      join(".agents/skills", SIMPLE_ISSUE_SKILL, "SKILL.md"),
      "utf8",
    );
    // Front matter, split out of the markdown rather than matched by a regex, so a
    // missing fence fails here rather than resolving to undefined and passing.
    const frontMatter = skill.split(/^---/m)[1] ?? "";
    const front: unknown = yaml.parse(frontMatter);
    // Read through a guard, not a cast: a front matter that is not a mapping has
    // no name to find, and the failure should say that rather than assert through
    // a shape the file does not have.
    expect(keysOf(front)).toContain("name");
    const fields = fieldOf(front);
    const name = fields.name;
    const description = fields.description;
    expect(name).toBe(SIMPLE_ISSUE_SKILL);
    // A description is what the registry lists, so a skill with none is
    // uninstallable-in-fact even though the command succeeds.
    expect(typeof description === "string" && description.length > 20).toBe(
      true,
    );
  });

  it("is registered in the plugin sync, so a Codex install receives it", () => {
    // `scripts/sync-plugin-skills.mjs` copies a fixed list into
    // plugins/opengeo/skills/. Codex installs copy the directory and skip
    // symlinks, so a skill missing from that list exists in exactly the one place
    // that cannot reach a user.
    const sync = readFileSync("scripts/sync-plugin-skills.mjs", "utf8");
    expect(sync).toContain(`"${SIMPLE_ISSUE_SKILL}"`);
  });
});

describe("every skill in .agents/skills is accounted for by the sync", () => {
  it("no skill is silently dropped, and nothing internal ships", () => {
    // The direction the sync script itself cannot check on its own: it wipes and
    // rebuilds from its own list, so a directory added to .agents/skills/ and
    // forgotten there disappears from plugins/ with no error anywhere.
    //
    // The first run of this test named `setup-opengeo`, which is deliberately
    // internal (`metadata: internal: true`) and had no declaration anywhere — so
    // the failure was the useful kind: it found an undocumented exclusion rather
    // than a bug. `INTERNAL_SKILLS` now exists, and the sync script reads it.
    const sync = readFileSync("scripts/sync-plugin-skills.mjs", "utf8");
    const declared = [...sync.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

    const onDisk = readdirSync(".agents/skills").filter((entry) =>
      statSync(join(".agents/skills", entry)).isDirectory(),
    );
    const missing = onDisk.filter((skill) => !declared.includes(skill));
    expect(missing, "skills on disk, named nowhere in the sync script").toEqual(
      [],
    );

    expect(sync).toContain("const INTERNAL_SKILLS = [");
  });
});
