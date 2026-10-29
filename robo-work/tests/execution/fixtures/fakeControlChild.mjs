// A fake orchestration domain for the control-stream reader tests. It is an ordinary Node child whose stdin, stdout and
// stderr are the supervisor's pipes. The mode (argv[2]) and a JSON option object (argv[3]) select the behaviour.
import fs from 'node:fs';

const [, , mode, optionText] = process.argv;
const options = JSON.parse(optionText || '{}');
const write = (stream, data) => new Promise((resolve) => { if (stream.write(data)) resolve(); else stream.once('drain', resolve); });
const finish = (name) => { if (options.doneFile) fs.writeFileSync(options.doneFile, name); };
const record = (index, size) => {
    const base = JSON.stringify({ type: 'event', n: index, pad: '' });
    return `${JSON.stringify({ type: 'event', n: index, pad: 'p'.repeat(Math.max(0, size - base.length)) })}\n`;
};

switch (mode) {
    case 'records':
        for (let index = 0; index < options.count; index += 1) await write(process.stdout, record(index, options.size || 0));
        finish('records');
        break;
    case 'raw':
        // Raw bytes written to stdout exactly as given (base64), for malformed and boundary cases.
        await write(process.stdout, Buffer.from(options.base64, 'base64'));
        finish('raw');
        setInterval(() => {}, 1000);
        break;
    case 'unterminated': {
        const chunk = Buffer.alloc(options.chunk || 65536, 0x61);
        let sent = 0;
        while (sent < options.total) { await write(process.stdout, chunk); sent += chunk.length; if (options.doneFile) fs.writeFileSync(options.doneFile, String(sent)); }
        setInterval(() => {}, 1000);
        break;
    }
    case 'stderr': {
        // A deterministic stream: byte i is (i * 7 + 3) & 0xff.
        const block = 65536;
        for (let written = 0; written < options.total; written += block) {
            const size = Math.min(block, options.total - written);
            const chunk = Buffer.alloc(size);
            for (let index = 0; index < size; index += 1) chunk[index] = ((written + index) * 7 + 3) & 0xff;
            await write(process.stderr, chunk);
        }
        await write(process.stdout, record(0, 0));
        finish('stderr');
        setInterval(() => {}, 1000);
        break;
    }
    case 'stderr-flood': {
        // One 64 KiB block repeated: the fastest honest flood. Byte i of the block is (i * 7 + 3) & 0xff.
        const block = Buffer.alloc(65536);
        for (let index = 0; index < block.length; index += 1) block[index] = (index * 7 + 3) & 0xff;
        for (let written = 0; written < options.total; written += block.length) await write(process.stderr, block);
        await write(process.stdout, record(0, 0));
        finish('stderr-flood');
        setInterval(() => {}, 1000);
        break;
    }
    case 'echo':
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (text) => { for (const line of text.split('\n').filter(Boolean)) process.stdout.write(`${JSON.stringify({ type: 'echo', line: JSON.parse(line) })}\n`); });
        break;
    default:
        // 'hold' and the stdin-ignoring modes: never reads stdin.
        setInterval(() => {}, 1000);
}
