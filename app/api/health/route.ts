export async function GET() {
  return Response.json({
    status: "ok",
    dataMode: "live-search-only",
    liveSearchProvider: "yandex",
    liveSearchAvailable: Boolean(process.env.YANDEX_API_KEY && process.env.YANDEX_FOLDER_ID),
  });
}
