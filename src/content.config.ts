import { defineCollection } from 'astro:content';
import { z } from "zod"
import { glob } from 'astro/loaders';

const projects = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/projects' }),
  schema: z.object({
    title: z.string(),
    date: z.string(),
    description: z.string().optional(),
    thumbnail: z.string().optional(),
    tags: z.array(z.string()).default([]),
    order: z.number().optional(),
  }),
});

export const collections = { projects };