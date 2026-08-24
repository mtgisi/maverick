// Tool dispatch: validate arguments, enforce the permission tier, audit, then run.
//
// Every path into a tool goes through dispatch(). The MCP adapter uses it, and the local
// agent loop will use it. Nothing calls a handler directly, because the tier check and the
// audit row live here.
//
// Argument validation is not decoration. A 7B model will emit entry_id as a string where
// the schema says number, omit required fields, and occasionally invent a parameter name.
// Per LOCAL-BRAIN-SPEC 8.2 the fix is to coerce the obvious mismatches, and on a genuine
// failure hand the validation error back as the tool result so the model can retry against
// the real schema. That retry loop is what makes a small model usable.

const registry = require('./registry');
const audit = require('../services/audit');

// ---- minimal JSON Schema check -------------------------------------------------------
// Deliberately covers only what registry.js actually uses: type, properties, required,
// enum. It is not a general validator and should not grow into one; if a tool needs more
// than this, that is a signal the tool's arguments are too complicated for a small model.

const TYPE_OF = v => Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);

// Coerce the mismatches a model reliably produces, and only those.
function coerce(value, want) {
  if (want === 'number' || want === 'integer') {
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  if (want === 'boolean') {
    if (value === 'true' || value === 'True') return true;
    if (value === 'false' || value === 'False') return false;
  }
  if (want === 'string' && (typeof value === 'number' || typeof value === 'boolean')) return String(value);
  return value;
}

function validate(schema, args) {
  const errors = [];
  const out = { ...args };
  const props = (schema && schema.properties) || {};
  const required = (schema && schema.required) || [];

  for (const key of required) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      errors.push(`missing required argument "${key}"`);
    }
  }

  for (const [key, value] of Object.entries(out)) {
    const spec = props[key];
    if (!spec) {
      // Reject rather than silently drop. A model that writes role_key instead of role
      // would otherwise be told "Saved" while the tag it asked for was thrown away, and it
      // would never learn. One retry against the real argument list is the cheaper failure.
      errors.push(`unknown argument "${key}" (valid: ${Object.keys(props).join(', ') || 'none'})`);
      delete out[key];
      continue;
    }
    if (value === undefined || value === null) continue;
    if (spec.type) {
      const fixed = coerce(value, spec.type);
      const got = TYPE_OF(fixed);
      const want = spec.type === 'integer' ? 'number' : spec.type;
      if (got !== want) {
        errors.push(`argument "${key}" must be ${spec.type}, got ${got}`);
        continue;
      }
      out[key] = fixed;
    }
    if (spec.enum && !spec.enum.includes(out[key])) {
      errors.push(`argument "${key}" must be one of: ${spec.enum.join(', ')}`);
    }
  }

  return { ok: errors.length === 0, errors, args: out };
}

// ---- permission policy ---------------------------------------------------------------
// read  / write      : allowed, audited.
// privileged         : allowed only when the tool is self-gating (its effect is a proposal
//                      a human must confirm, so calling it cannot change anything on its
//                      own) or the caller presents an explicit confirmation / grant.
//
// Today the only privileged tool is propose_timesheet_change, which is self-gating. The
// bastion send tools land here later and are NOT self-gating, so they will be refused
// without a grant. This is the enforcement point for that.
function permit(tool, ctx) {
  if (tool.tier !== 'privileged') return { ok: true };
  if (tool.selfGated) return { ok: true };
  if (ctx.confirmed) return { ok: true };
  return { ok: false, reason: `"${tool.name}" is a privileged action and needs explicit confirmation.` };
}

// ---- dispatch ------------------------------------------------------------------------

// Run a tool by name. Never throws: a failure comes back as an error string, because the
// caller is usually a model that needs to read the failure and retry.
async function dispatch(name, rawArgs = {}, ctx = {}) {
  const tool = registry.get(name);
  if (!tool) {
    return { ok: false, tool: name, result: `error: unknown tool "${name}". Available: ${registry.names().join(', ')}` };
  }

  const schema = tool.schema; // may be a getter; read once
  const v = validate(schema, rawArgs || {});
  if (!v.ok) {
    // Not audited as an invocation: nothing ran. Surfaced to the model so it can retry.
    return { ok: false, tool: name, result: `error: invalid arguments — ${v.errors.join('; ')}` };
  }

  const gate = permit(tool, ctx);
  if (!gate.ok) {
    const row = audit.begin({ tool: name, tier: tool.tier, args: v.args, ctx });
    row.done(false, gate.reason);
    return { ok: false, tool: name, result: `error: ${gate.reason}` };
  }

  const row = audit.begin({ tool: name, tier: tool.tier, args: v.args, ctx });
  try {
    const raw = await tool.handler(v.args, ctx);
    const result = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
    // Handlers signal recoverable problems by returning an "error: ..." string rather than
    // throwing (a model reads the string and retries). Audit it as a failure even so, or
    // the activity view reports a tool that refused as one that worked.
    const handled = typeof result === 'string' && result.startsWith('error:');
    row.done(!handled, result);
    return { ok: !handled, tool: name, tier: tool.tier, result };
  } catch (e) {
    row.done(false, e);
    return { ok: false, tool: name, tier: tool.tier, result: `error: ${e.message}` };
  }
}

module.exports = { dispatch, validate, permit, registry };
