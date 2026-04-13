export const prerender = false;
import { MongoClient } from 'mongodb';

export async function GET({ request }) {
    try {
        const uri = import.meta.env.MONGO_URI;
        if (!uri) throw new Error("MONGO_URI is not defined in .env");

        const url = new URL(request.url);
        const range = url.searchParams.get('range'); // 'week' or 'alltime'

        const client = new MongoClient(uri);
        await client.connect();

        const db = client.db('takatime');
        const collection = db.collection('logs');

        const pipeline = [];

        if (range === 'week') {
            const sevenDaysAgo = new Date();
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
            const dateStr = sevenDaysAgo.toISOString().split('T')[0];
            pipeline.push({ $match: { date: { $gte: dateStr } } });
        }

        pipeline.push(
            {
                $addFields: {
                    normalizedLanguage: {
                        $switch: {
                            branches: [
                                { case: { $eq: ['$language', 'cpp'] },             then: 'c++' },
                                { case: { $eq: ['$language', 'javascriptreact'] }, then: 'jsx' },
                                { case: { $eq: ['$language', 'typescriptreact'] }, then: 'tsx' },
                                { case: { $eq: ['$language', 'shellscript'] },     then: 'shell' },
                                { case: { $eq: ['$language', 'unknown'] },         then: 'other' },
                            ],
                            default: '$language'
                        }
                    }
                }
            },
            { $group: { _id: '$normalizedLanguage', totalDuration: { $sum: '$duration' } } },
            { $sort: { totalDuration: -1 } }
        );

        const results = await collection.aggregate(pipeline).toArray();
        await client.close();

        const total = results.reduce((sum, r) => sum + r.totalDuration, 0);

        const languages = results.map(r => ({
            name: r._id,
            percent: total > 0 ? parseFloat(((r.totalDuration / total) * 100).toFixed(1)) : 0
        }));

        return new Response(JSON.stringify({ data: { languages } }), {
            status: 200,
            headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}