'use server';
import { revalidateTag, updateTag } from 'next/cache';

export async function save() {
  revalidateTag('posts');
}

export async function saveGood() {
  revalidateTag('posts', 'max');
  updateTag('posts');
}
