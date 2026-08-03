export function createBankLaneFeedRoutes({ bankLaneFeed, respond }) {
  return async function handleBankLaneFeedRoute({ request, response, pathname }) {
    if (request.method !== "GET" || pathname !== "/monitor/bank-feed") {
      return false;
    }

    respond(response, 200, await bankLaneFeed.getFeed());
    return true;
  };
}
