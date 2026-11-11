/**
 * Packaging regression tests for the bundled Skill (v1.3.0).
 *
 * A Skill that is not in `package.json.files` is not published; a Skill whose
 * directory is not mounted by the bundle patch is not discoverable; and a Skill
 * whose frontmatter is malformed never reaches the Skill catalog. Those are the
 * three failure modes this test pins down without loading DSH.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

const pkgDir = path.resolve(__dirname, '..')
const skillDir = path.join(pkgDir, 'skills', 'session-handoff')
const skillFile = path.join(skillDir, 'SKILL.md')

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  assert.ok(match, 'SKILL.md must start with a YAML frontmatter block')
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const at = line.indexOf(':')
    assert.ok(at > 0, `frontmatter line has no key: ${line}`)
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { fields, body: text.slice(match[0].length) }
}

test('skills/session-handoff/SKILL.md exists with valid frontmatter', () => {
  assert.ok(existsSync(skillFile), skillFile)
  const { fields, body } = frontmatter(readFileSync(skillFile, 'utf8'))
  assert.equal(fields.name, 'session-handoff', 'frontmatter name must equal the skill id')
  assert.ok(fields.description && fields.description.length >= 20, 'description is required and non-trivial')
  assert.ok(fields.whenToUse && fields.whenToUse.length >= 20, 'whenToUse is required for minimal-prompt discovery')
  // The Skill must teach the handoff contract, not just describe it.
  for (const needle of ['session_handoff', 'context_pct', 'HANDOFF', '50']) {
    assert.match(body, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `body must mention ${needle}`)
  }
})

test('package.json publishes the skills directory', () => {
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.ok(Array.isArray(pkg.files), 'files must be an array')
  assert.ok(pkg.files.includes('skills'), 'package.json.files must include "skills" or the Skill is not published')
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
})

test('bundle patch mounts a filesystem Skill provider on the packaged skills/', () => {
  const patch = readFileSync(path.join(pkgDir, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /@deepseek-ai\/dsh-skill-filesystem/, 'patch must insert the filesystem Skill provider')
  assert.match(patch, /providerName:\s*session-tree\b/, 'providerName must be stable')
  assert.match(patch, /includeDefaultRoots:\s*false/, 'bundled skill dir must not duplicate the default roots')
  assert.match(patch, /bundledSkillDir:/, 'bundledSkillDir must be configured')
  assert.match(patch, /'skills'\)/, 'bundledSkillDir must resolve to the packaged skills directory')
  assert.match(patch, /@orphiczhou\/dsh-session-tree\/package\.json/, 'the directory must be resolved via the installed package identity')
})
