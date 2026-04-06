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
                'Authorization': `Basic ${token}`
            }
        });

        const data = await res.json();

        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 
                "Content-Type": "application/json",
                // This tells Cloudflare/Browsers NOT to cache this specific data
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}