// Shared team skills: Claude Code skill files in ./skills/<id>/SKILL.md.
// Every agent loads all of them. They change through git, not from the room.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url));
const SKILL_ID = /^[a-z0-9][a-z0-9-]*$/;

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: text.slice(m[0].length) };
}

export function loadSkills(dir = SKILLS_DIR) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && SKILL_ID.test(e.name))
    .flatMap((e) => {
      let content;
      try {
        content = readFileSync(join(dir, e.name, 'SKILL.md'), 'utf8');
      } catch {
        return [];
      }
      const { fields, body } = frontmatter(content);
      return [{
        id: e.name,
        name: fields.name || e.name,
        description: fields.description || '',
        path: `skills/${e.name}/SKILL.md`,
        body: body.trim(),
        content,
      }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export const isSkillId = (id) => typeof id === 'string' && SKILL_ID.test(id);
