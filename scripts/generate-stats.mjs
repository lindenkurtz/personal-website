import { MongoClient } from 'mongodb';
import { writeFileSync } from 'fs';

const NORMALIZE = {
    'cpp': 'c++',
    'jsonc': 'json',
    'jsonl': 'json',
    'javascriptreact': 'jsx',
    'typescriptreact': 'tsx',
    'shellscript': 'shell',
    'unknown': 'other',
};

async function getLanguages(collection, dateFilter = null) {
    const pipeline = [];
    if (dateFilter) pipeline.push({ $match: { date: { $gte: dateFilter } } });
    pipeline.push(
        { $addFields: { normalizedLanguage: { $switch: {
            branches: Object.entries(NORMALIZE).map(([k, v]) => ({
                case: { $eq: ['$language', k] }, then: v
            })),
            default: '$language'
        }}}},
        { $group: { _id: '$normalizedLanguage', totalDuration: { $sum: '$duration' } } },
        { $sort: { totalDuration: -1 } }
    );
    const results = await collection.aggregate(pipeline).toArray();
    const total = results.reduce((sum, r) => sum + r.totalDuration, 0);
    return results.map(r => ({
        name: r._id,
        percent: parseFloat(((r.totalDuration / total) * 100).toFixed(1))
    }));
}

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const collection = client.db('takatime').collection('logs');

const sevenDaysAgo = new Date();
sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
const dateStr = sevenDaysAgo.toISOString().split('T')[0];

const [week, alltime] = await Promise.all([
    getLanguages(collection, dateStr),
    getLanguages(collection)
]);

await client.close();

writeFileSync('public/coding-stats.json', JSON.stringify({ week, alltime }, null, 2));
console.log('Stats written to public/coding-stats.json');