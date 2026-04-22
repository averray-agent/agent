#!/usr/bin/env node

const endpoint = process.env.POLKADOT_DOCS_MCP_URL || 'https://docs-mcp.polkadot.com';
const userAgent =
  process.env.POLKADOT_DOCS_MCP_USER_AGENT || 'codex-cli/0.122.0-alpha.13 stdio-bridge';

let sessionId = null;
let inputBuffer = Buffer.alloc(0);
let requestChain = Promise.resolve();
let shuttingDown = false;

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  drainInput();
});

process.stdin.on('end', () => {
  requestChain
    .catch(() => {})
    .then(() => shutdown())
    .finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});

function drainInput() {
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const headerText = inputBuffer.slice(0, headerEnd).toString('utf8');
    const contentLength = parseContentLength(headerText);
    if (contentLength == null) {
      writeRpcError(null, -32700, 'Missing Content-Length header');
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + contentLength;
    if (inputBuffer.length < messageEnd) {
      return;
    }

    const messageBuffer = inputBuffer.slice(messageStart, messageEnd);
    inputBuffer = inputBuffer.slice(messageEnd);
    const messageText = messageBuffer.toString('utf8');

    requestChain = requestChain
      .then(() => forwardMessage(messageText))
      .catch((error) => {
        const messageId = extractMessageId(messageText);
        writeRpcError(messageId, -32000, error.message || String(error));
      });
  }
}

function parseContentLength(headerText) {
  for (const line of headerText.split('\r\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }

    const headerName = line.slice(0, separatorIndex).trim().toLowerCase();
    const headerValue = line.slice(separatorIndex + 1).trim();
    if (headerName === 'content-length') {
      const parsed = Number.parseInt(headerValue, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }

  return null;
}

function extractMessageId(messageText) {
  try {
    const parsed = JSON.parse(messageText);
    return parsed?.id ?? null;
  } catch {
    return null;
  }
}

async function forwardMessage(messageText) {
  let parsed;
  try {
    parsed = JSON.parse(messageText);
  } catch {
    writeRpcError(null, -32700, 'Invalid JSON-RPC payload');
    return;
  }

  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': userAgent,
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(parsed),
  });

  const responseSessionId = response.headers.get('mcp-session-id');
  if (responseSessionId) {
    sessionId = responseSessionId;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    await writeEventStreamMessages(response);
    return;
  }

  const responseText = await response.text();
  if (contentType.includes('application/json')) {
    writeFramed(responseText);
    return;
  }

  if (parsed?.id != null) {
    writeRpcError(
      parsed.id,
      -32000,
      `Remote MCP request failed with HTTP ${response.status}: ${responseText.slice(0, 200)}`
    );
  }
}

async function writeEventStreamMessages(response) {
  const decoder = new TextDecoder();
  let eventBuffer = '';

  for await (const chunk of response.body) {
    eventBuffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const eventBoundary = eventBuffer.indexOf('\n\n');
      if (eventBoundary === -1) {
        break;
      }

      const rawEvent = eventBuffer.slice(0, eventBoundary);
      eventBuffer = eventBuffer.slice(eventBoundary + 2);

      const payload = parseSseEvent(rawEvent);
      if (!payload || payload === '[DONE]') {
        continue;
      }

      writeFramed(payload);
    }
  }

  eventBuffer += decoder.decode();
  const trailingPayload = parseSseEvent(eventBuffer);
  if (trailingPayload && trailingPayload !== '[DONE]') {
    writeFramed(trailingPayload);
  }
}

function parseSseEvent(rawEvent) {
  const dataLines = [];
  const normalizedEvent = rawEvent.replace(/\r\n/g, '\n');

  for (const line of normalizedEvent.split('\n')) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  return dataLines.join('\n');
}

function writeRpcError(id, code, message) {
  writeFramed(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })
  );
}

function writeFramed(messageText) {
  const payload = Buffer.from(messageText, 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  if (!sessionId) {
    return;
  }

  try {
    await fetch(endpoint, {
      method: 'DELETE',
      headers: {
        'User-Agent': userAgent,
        'mcp-session-id': sessionId,
      },
    });
  } catch {
    return;
  }
}
