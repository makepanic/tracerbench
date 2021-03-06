import type { Protocol } from 'devtools-protocol';

import { createBrowser, getBrowserArgs, getNewTab } from './utils';
import debug = require('debug');
import { SessionConnection } from 'chrome-debugging-client';

type QuerySelectorOptions = {
  nodeId: number;
  selector: string;
};

// run with DEBUG=* eg.`DEBUG=* tracerbench record-har:auth`
// run with DEBUG=tracerbench:auth eg.`DEBUG=tracerbench:auth tracerbench record-har:auth`
const debugCallback = debug('tracerbench:auth');

export async function authClient(
  url: string,
  username: string,
  password: string,
  headless = false,
  altBrowserArgs?: string[]
): Promise<Protocol.Network.Cookie[]> {
  const browserArgs = getBrowserArgs(altBrowserArgs);
  const browser = await createBrowser(browserArgs, headless);
  let cookieResponse: Protocol.Network.GetCookiesResponse;
  try {
    const chrome = await getNewTab(browser.connection, url);

    // enable Page / DOM / Network / Runtime
    await Promise.all([
      chrome.send('Page.enable'),
      chrome.send('DOM.enable'),
      chrome.send('Network.enable'),
      chrome.send('Runtime.enable')
    ]);

    // clear and disable cache
    await chrome.send('Network.clearBrowserCache');
    // navigate to the url
    await chrome.send('Page.navigate', { url });
    // wait for the app to load
    await chrome.until('Page.loadEventFired');
    // grab the document
    const document = await chrome.send('DOM.getDocument');

    // grab the username nodeId
    const usernameNode = await waitForSelector(document, '#username', chrome);
    debugCallback('usernameNode %o', usernameNode);

    // set the value for the username
    await chrome.send('DOM.setAttributeValue', {
      nodeId: usernameNode.nodeId,
      name: 'value',
      value: username
    });

    // grab the username nodeId
    const passwordNode = await waitForSelector(document, '#password', chrome);
    debugCallback('passwordNode %o', passwordNode);

    // set the value for the username
    await chrome.send('DOM.setAttributeValue', {
      nodeId: passwordNode.nodeId,
      name: 'value',
      value: password
    });

    await click('button[type=submit]', chrome);
    await chrome.until('Page.loadEventFired');

    // The list of URLs for which applicable cookies will be fetched
    cookieResponse = await chrome.send('Network.getCookies', [url]);

    await Promise.all([
      chrome.send('Network.disable'),
      chrome.send('DOM.disable'),
      chrome.send('Runtime.disable')
    ]);

    await chrome.send('Page.close');
  } catch (e) {
    throw new Error(e);
  } finally {
    if (browser) {
      await browser.dispose();
      debugCallback('browser.dispose()');
    }
  }

  return cookieResponse.cookies;
}

/**
 * Get the node based on the selector form
 */

async function waitForSelector(
  document: Protocol.DOM.GetDocumentResponse,
  selector: string,
  chrome: SessionConnection
): Promise<{ nodeId: number; node: Protocol.DOM.ResolveNodeResponse }> {
  const options: QuerySelectorOptions = {
    nodeId: document.root.nodeId,
    selector
  };
  const { nodeId } = await chrome.send('DOM.querySelector', options);
  const node = await chrome.send('DOM.resolveNode', { nodeId });
  return { nodeId, node };
}

/**
 * Click on the submit button selector
 */

async function click(
  selector: string,
  chrome: SessionConnection
): Promise<Protocol.Runtime.RemoteObject | Record<string, unknown>> {
  const remoteObject = await evaluate(selector, chrome);
  if (remoteObject?.objectId) {
    const { exceptionDetails, result } = await chrome.send(
      'Runtime.callFunctionOn',
      {
        functionDeclaration: 'function() { return this.click() }',
        objectId: remoteObject.objectId,
        awaitPromise: true
      }
    );
    return exceptionDetails ? {} : result;
  }

  return {};
}

/**
 * Evaluates the expression
 */
async function evaluate(
  selector: string,
  chrome: SessionConnection
): Promise<Protocol.Runtime.RemoteObject | undefined> {
  const expression = `document.querySelector("${selector}")`;
  const { exceptionDetails, result } = await chrome.send('Runtime.evaluate', {
    expression
  });
  if (exceptionDetails) {
    debugCallback('evaluate', exceptionDetails);
    return undefined;
  }
  return result;
}
