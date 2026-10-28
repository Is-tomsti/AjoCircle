import { OneClickQuoteClient, parseOneClickQuotePreview } from './oneclick-quote.mjs';
import { MockOneClickQuoteProvider } from './mock-oneclick-quote-provider.mjs';

export function createTestnetQuoteClient({ config = {}, fetchImpl = fetch } = {}) {
  const token = config.ONECLICK_API_TOKEN?.trim();
  const quoteBackendConfigured = Boolean(token);
  const allowLivePreview = config.AJO_TESTNET_ALLOW_LIVE_1CLICK_PREVIEW === 'true';
  const offlineMock = config.AJO_TESTNET_PREVIEW_PROVIDER === 'offline-mock';

  const liveClient = new OneClickQuoteClient({
    ...(token ? { bearerToken: token } : {}),
    fetchImpl,
  });
  const mockProvider = new MockOneClickQuoteProvider();

  const quoteClient = {
    getQuote: request => liveClient.getQuote(request),
    getQuotePreview: async request => {
      if (request?.dry !== true) {
        throw new Error('Preview requests must set dry=true.');
      }
      if (offlineMock) {
        return parseOneClickQuotePreview(
          await mockProvider.getQuotePreview(request),
          request,
        );
      }
      if (!allowLivePreview) {
        throw new Error('Live 1Click preview is disabled in the testnet app.');
      }
      return liveClient.getQuotePreview(request);
    },
  };

  return { quoteBackendConfigured, quoteClient };
}
