#!/usr/bin/env node

'use strict';

const DEFAULT_API_BASE_URL = 'https://vmpix-data.onrender.com';
const API_BASE_URL = String(process.env.API_BASE_URL || DEFAULT_API_BASE_URL).trim().replace(/\/+$/, '');
const ADMIN_TOKEN = String(
  process.env.SMOKE_ADMIN_TOKEN || process.env.API_ADMIN_TOKEN || process.env.ADMIN_TOKEN || ''
).trim();
const REQUEST_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 15000);

const requiredRoutes = [
  '/health',
  '/health/db',
  '/health/tables',
  '/api/music/bands/db?limit=1',
  '/api/music/shows/db?limit=1',
  '/api/music/people/db?limit=1',
  '/api/music/venues/db?limit=1',
  '/api/music/bands/stats',
  '/api/music/shows/stats',
  '/api/music/people/stats',
  '/api/music/venues/stats',
  '/api/wrestling/shows/db?limit=1',
  '/api/wrestling/people/db?limit=1'
];

const protectedRoutes = [
  '/api/admin/diagnostics'
];

function formatStatus(status) {
  return status ? String(status) : 'n/a';
}

function truncate(value, maxLength = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function summarizeBody(contentType, body) {
  if (!body) return '';

  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(body);
      return truncate(
        parsed.error ||
        parsed.message ||
        parsed.status ||
        (parsed.ok === false && 'ok=false') ||
        body
      );
    } catch {
      return truncate(body);
    }
  }

  return truncate(body);
}

function summarizeError(err) {
  if (!err) return 'unknown error';
  if (err.name === 'AbortError') return `request timed out after ${REQUEST_TIMEOUT_MS}ms`;

  const parts = [];
  if (err.message) parts.push(err.message);

  const cause = err.cause;
  if (cause) {
    const causeParts = [cause.code, cause.message].filter(Boolean);
    if (causeParts.length) parts.push(causeParts.join(': '));
  }

  return truncate(parts.join(' - ') || String(err));
}

async function checkRoute(route, options = {}) {
  if (options.protected && !ADMIN_TOKEN) {
    return {
      route,
      skipped: true,
      status: null,
      summary: 'admin token missing'
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    Accept: 'application/json'
  };

  if (options.protected && ADMIN_TOKEN) {
    headers['x-admin-token'] = ADMIN_TOKEN;
  }

  try {
    const response = await fetch(`${API_BASE_URL}${route}`, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    const body = await response.text();
    const contentType = response.headers.get('content-type') || '';

    return {
      route,
      status: response.status,
      ok: response.ok,
      summary: response.ok ? '' : summarizeBody(contentType, body)
    };
  } catch (err) {
    return {
      route,
      status: null,
      ok: false,
      summary: summarizeError(err)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function printResult(result, options = {}) {
  const label = result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL';
  const optional = options.required ? '' : ' optional';
  const detail = result.summary ? ` - ${result.summary}` : '';
  console.log(`${label}${optional} ${result.route} [${formatStatus(result.status)}]${detail}`);
}

async function main() {
  console.log(`Smoke API base: ${API_BASE_URL}`);
  console.log(`Timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log('');

  const requiredResults = [];
  for (const route of requiredRoutes) {
    const result = await checkRoute(route, { required: true });
    requiredResults.push(result);
    printResult(result, { required: true });
  }

  for (const route of protectedRoutes) {
    const result = await checkRoute(route, { protected: true });
    printResult(result, { protected: true });
  }

  const failedRequired = requiredResults.filter((result) => !result.ok);
  console.log('');

  if (failedRequired.length) {
    console.error(`Smoke API failed: ${failedRequired.length} required route(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log('Smoke API passed: all required routes responded successfully.');
}

main().catch((err) => {
  console.error(`Smoke API crashed: ${err && err.message ? err.message : String(err)}`);
  process.exitCode = 1;
});
