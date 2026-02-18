/**
 * Parse SSE frames from a ReadableStream (from fetch response.body).
 * Yields { event, data, id, retry } objects for each complete SSE message.
 */
export async function* parseSSEStream(readable) {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of readable) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    const parts = buffer.split('\n\n');
    // Keep the last (possibly incomplete) part in the buffer
    buffer = parts.pop() || '';

    for (const part of parts) {
      if (!part.trim()) continue;

      const frame = { event: null, data: null, id: null, retry: null };
      for (const line of part.split('\n')) {
        if (line.startsWith('data: ')) {
          const val = line.slice(6);
          frame.data = frame.data === null ? val : frame.data + '\n' + val;
        } else if (line.startsWith('event: ')) {
          frame.event = line.slice(7);
        } else if (line.startsWith('id: ')) {
          frame.id = line.slice(4);
        } else if (line.startsWith('retry: ')) {
          frame.retry = parseInt(line.slice(7), 10);
        } else if (line === 'data:') {
          frame.data = frame.data === null ? '' : frame.data + '\n';
        }
      }

      if (frame.data !== null) {
        // Try to parse JSON data
        if (frame.data === '[DONE]') {
          frame.parsedData = null;
          frame.done = true;
        } else {
          try {
            frame.parsedData = JSON.parse(frame.data);
          } catch {
            frame.parsedData = null;
          }
        }
        yield frame;
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim()) {
    const frame = { event: null, data: null, id: null, retry: null };
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data: ')) {
        const val = line.slice(6);
        frame.data = frame.data === null ? val : frame.data + '\n' + val;
      }
    }
    if (frame.data !== null) {
      if (frame.data === '[DONE]') {
        frame.parsedData = null;
        frame.done = true;
      } else {
        try { frame.parsedData = JSON.parse(frame.data); } catch { frame.parsedData = null; }
      }
      yield frame;
    }
  }
}

/**
 * Format an SSE frame for sending to a client.
 */
export function formatSSE(data, event) {
  let out = '';
  if (event) out += `event: ${event}\n`;
  if (typeof data === 'string') {
    out += `data: ${data}\n\n`;
  } else {
    out += `data: ${JSON.stringify(data)}\n\n`;
  }
  return out;
}
