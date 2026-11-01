import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The Desktop image ships Chromium only in its application menu. A desktop icon lets the robot
// find it in a screenshot; roboteam-open-browser starts it with the robot's profile or focuses
// the window that is already open.
export const CHROMIUM_LAUNCHER = `[Desktop Entry]
Version=1.0
Type=Application
Name=Chromium
Comment=Web browser
Exec=/usr/local/bin/roboteam-open-browser
Icon=chromium
Terminal=false
Categories=Network;WebBrowser;
`;

// Writes the icons into <robot home>/Desktop, which the Desktop container mounts as /config/Desktop.
// XFCE runs executable launchers in the user's Desktop folder without a trust prompt.
export async function prepareDesktopLaunchers(home) {
    const directory = path.join(home, 'Desktop');
    await fs.mkdir(directory, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const entry = await fs.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe robot desktop directory');
    const target = path.join(directory, 'chromium.desktop');
    const current = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current?.isFile() && (current.mode & 0o777) === 0o755 && await fs.readFile(target, 'utf8') === CHROMIUM_LAUNCHER) return;
    const temporary = path.join(directory, `.chromium.desktop.${crypto.randomBytes(6).toString('hex')}`);
    try {
        await fs.writeFile(temporary, CHROMIUM_LAUNCHER, { mode: 0o755, flag: 'wx' });
        await fs.chmod(temporary, 0o755);
        await fs.rename(temporary, target);
    } catch (error) {
        await fs.rm(temporary, { force: true });
        throw error;
    }
}
