import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function mask(str?: string): string {
    if (!str) return '(empty)';
    if (str.length < 4) return '***';
    return str.substring(0, 2) + '*'.repeat(str.length - 4) + str.substring(str.length - 2);
}

console.log('=== Environment Variable Check ===');
console.log(`Current Directory: ${process.cwd()}`);
console.log(`PROFINDER_URL: ${process.env.PROFINDER_URL || '(undefined)'}`);
console.log(`PROFINDER_USER: ${mask(process.env.PROFINDER_USER)}`);
console.log(`PROFINDER_PASS: ${mask(process.env.PROFINDER_PASS)}`);
console.log(`PROFARM_URL: ${process.env.PROFARM_URL || '(undefined)'}`);
console.log(`PROFARM_USER: ${mask(process.env.PROFARM_USER)}`);
console.log(`PROFARM_PASS: ${mask(process.env.PROFARM_PASS)}`);
console.log(`SPREADSHEET_ID: ${mask(process.env.SPREADSHEET_ID)}`);
console.log(`LINE_CHANNEL_ACCESS_TOKEN: ${mask(process.env.LINE_CHANNEL_ACCESS_TOKEN)}`);
console.log(`LINE_USER_ID: ${mask(process.env.LINE_USER_ID)}`);
