import { codeshift } from 'react-codeshift';
import { helper } from '@acme/pkg/sub/path';
import { sub } from '@/lib/other';
import { lib } from '~lib/other';
import { chunk } from 'lodash/chunk';
import fs from 'node:fs';
import path from 'path';
import 'server-only';

export const cn = (...c: string[]) => c.join(' ') + String(codeshift) + String(helper) + String(sub) + String(lib) + String(chunk) + String(fs) + String(path);
export const secret = process.env.NEXT_PUBLIC_API_TOKEN;
export const ok = process.env.NEXT_PUBLIC_API_URL;
