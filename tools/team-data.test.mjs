import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/* src/_data/team.json is the whole Meet the Team page -- src/meet-the-team.html
   is a loop over it. Nothing else validates it, so a typo in a group id or a
   photo filename ships as a missing card or a broken image. */
const ROOT = path.join(import.meta.dirname, '..');
const team = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/_data/team.json'), 'utf8'));

/* The class is concatenated onto "team-grid", so the leading space is part of
   the value and the column count is baked into the CSS. */
const COLUMNS = { '': 4, ' three': 3, ' five': 5 };

test('every group declares a grid the stylesheet knows', () => {
  for (const group of team.groups) {
    assert.ok(
      Object.hasOwn(COLUMNS, group.gridModifier),
      `group "${group.id}" has gridModifier ${JSON.stringify(group.gridModifier)}, ` +
        `which is not one of ${Object.keys(COLUMNS).map((k) => JSON.stringify(k)).join(', ')}`
    );
  }
});

test('a group with a fixed column count holds exactly that many people', () => {
  /* " five" is a five-column grid, so a sixth person wraps to a second row
     holding one card. The roster is set by who actually holds each role --
     this only catches the case where a group's size and its declared column
     count have drifted apart. The four-column default is flexible and is not
     checked. */
  for (const group of team.groups) {
    const columns = COLUMNS[group.gridModifier];
    if (columns === 4) continue;
    const members = team.members.filter((m) => m.group === group.id);
    assert.equal(
      members.length,
      columns,
      `group "${group.id}" renders ${columns} columns but holds ${members.length} people`
    );
  }
});

test('every member belongs to a declared group, and every group has members', () => {
  const ids = new Set(team.groups.map((g) => g.id));
  for (const member of team.members) {
    assert.ok(ids.has(member.group), `${member.name} is in unknown group "${member.group}"`);
  }
  for (const group of team.groups) {
    assert.ok(
      team.members.some((m) => m.group === group.id),
      `group "${group.id}" has no members and would render an empty heading`
    );
  }
});

test('every photo named actually exists', () => {
  /* The card falls back to initials when `photo` is absent. It cannot tell
     that a path which IS set points at nothing -- that renders a broken-image
     glyph over the gradient, which is the failure the fallback exists to
     avoid. */
  for (const member of team.members) {
    if (!member.photo) continue;
    const file = path.join(ROOT, 'src', member.photo);
    assert.ok(fs.existsSync(file), `${member.name}: no such file as ${member.photo}`);
  }
});

test('every member has a name and a role, and no name appears twice', () => {
  const seen = new Set();
  for (const member of team.members) {
    assert.ok(String(member.name || '').trim(), 'a member has no name');
    /* The card prints the role unconditionally; a blank one leaves an empty
       line under the name. */
    assert.ok(String(member.role || '').trim(), `${member.name} has no role`);
    assert.ok(!seen.has(member.name), `${member.name} is listed twice`);
    seen.add(member.name);
  }
});

test('every LinkedIn URL is a real profile address', () => {
  /* A member with no URL renders as an unlinked card, which is intended. One
     that is set has to go somewhere: "#" or an empty string would reload the
     page and read as a broken link. */
  for (const member of team.members) {
    if (!Object.hasOwn(member, 'linkedin')) continue;
    assert.match(
      member.linkedin,
      /^https:\/\/www\.linkedin\.com\/in\/[\w%-]+\/?$/,
      `${member.name} has linkedin ${JSON.stringify(member.linkedin)}`
    );
  }
});

test('gradients run g1 to g7 without restarting per group', () => {
  /* One continuous cycle across the whole roster, which is how the page has
     always been written: restarting at each heading puts the same gradient
     side by side across a group boundary. */
  team.members.forEach((member, i) => {
    assert.equal(
      member.gradient,
      `g${(i % 7) + 1}`,
      `${member.name} is ${member.gradient} at position ${i + 1}`
    );
  });
});
