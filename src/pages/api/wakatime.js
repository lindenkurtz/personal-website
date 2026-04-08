export const prerender = false;

export async function GET() {
    try {
        const apiKey = import.meta.env.WAKATIME_API_KEY;
        
        // Ensure apiKey exists to avoid Buffer errors
        if (!apiKey) {
            throw new Error("WAKATIME_API_KEY is not defined in .env");
        }

        const token = btoa(`${apiKey}:`);

        const res = await fetch('https://wakatime.com/api/v1/users/current/stats/last_7_days?is_including_today=true', {
            headers: {
                'Authorization': `Basic ${token}`,
                'Cache-Control': 'no-cache'
            }
        });

        const data = await res.json();

        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 
                "Content-Type": "application/json",
                // This tells Cloudflare/Browsers NOT to cache this specific data
                "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                "CDN-Cache-Control": "no-store", 
                "Vercel-CDN-Cache-Control": "no-store", // Cover all bases
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}