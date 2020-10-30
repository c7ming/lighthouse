/**
 * @license Copyright 2020 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const URL = require('../lib/url-shim.js');
const Audit = require('./audit.js');
const i18n = require('../lib/i18n/i18n.js');
const MainResource = require('../computed/main-resource.js');
const LanternLCP = require('../computed/metrics/lantern-largest-contentful-paint.js');
const LoadSimulator = require('../computed/load-simulator.js');
const UnusedBytes = require('./byte-efficiency/byte-efficiency-audit.js');

const UIStrings = {
  /** Title of a lighthouse audit that tells a user to preload an image in order to improve their LCP time. */
  title: 'Preload Largest Contentful Paint image',
  /** Description of a lighthouse audit that tells a user to preload an image in order to improve their LCP time.  */
  description: 'Preload the image used by ' +
    'the LCP element in order to improve your LCP time. [Learn more](https://web.dev/optimize-lcp/#preload-important-resources).',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

class PreloadLCPImageAudit extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'preload-lcp-image',
      title: str_(UIStrings.title),
      description: str_(UIStrings.description),
      requiredArtifacts: ['traces', 'devtoolsLogs', 'URL', 'TraceElements', 'ImageElements'],
      scoreDisplayMode: Audit.SCORING_MODES.NUMERIC,
    };
  }

  /**
   *
   * @param {LH.Artifacts.NetworkRequest} request
   * @param {LH.Artifacts.NetworkRequest} mainResource
   * @param {Array<LH.Gatherer.Simulation.GraphNode>} initiatorPath
   * @return {boolean}
   */
  static shouldPreloadRequest(request, mainResource, initiatorPath) {
    const mainResourceDepth = mainResource.redirects ? mainResource.redirects.length : 0;

    // If it's already preloaded, no need to recommend it.
    if (request.isLinkPreload) return false;
    // It's not a request loaded over the network, don't recommend it.
    if (URL.NON_NETWORK_PROTOCOLS.includes(request.protocol)) return false;
    // It's already discoverable from the main document, don't recommend it.
    if (initiatorPath.length <= mainResourceDepth + 1) return false;
    // Finally, return whether or not it belongs to the main frame
    return request.frameId === mainResource.frameId;
  }

  /**
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {string} imageUrl
   * @return {{lcpNode: LH.Gatherer.Simulation.GraphNetworkNode|undefined, path: Array<LH.Gatherer.Simulation.GraphNetworkNode>|undefined}}
   */
  static findLCPNode(graph, imageUrl) {
    let lcpNode;
    let path;
    graph.traverse((node, traversalPath) => {
      if (node.type !== 'network') return;
      if (node.record.url === imageUrl) {
        lcpNode = node;
        path =
          traversalPath.slice(1).filter(initiator => initiator.type === 'network');
      }
    });
    return {
      lcpNode,
      path,
    };
  }

  /**
   * @param {LH.Artifacts.NetworkRequest} mainResource
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {LH.Artifacts.TraceElement|undefined} lcpElement
   * @param {Array<LH.Artifacts.ImageElement>} imageElements
   * @return {LH.Gatherer.Simulation.GraphNetworkNode|undefined}
   */
  static getLCPNodeToPreload(mainResource, graph, lcpElement, imageElements) {
    if (!lcpElement) return undefined;

    const lcpImageElement = imageElements.find(elem => {
      return elem.devtoolsNodePath === lcpElement.devtoolsNodePath;
    });

    if (!lcpImageElement) return undefined;
    const lcpUrl = lcpImageElement.src;
    const {lcpNode, path} = PreloadLCPImageAudit.findLCPNode(graph, lcpUrl);
    if (!lcpNode || !path) return undefined;
    // eslint-disable-next-line max-len
    const shouldPreload = PreloadLCPImageAudit.shouldPreloadRequest(lcpNode.record, mainResource, path);
    return shouldPreload ? lcpNode : undefined;
  }

  /**
   * Computes the estimated effect of preloading the LCP image.
   * @param {LH.Gatherer.Simulation.GraphNetworkNode} lcpNode
   * @param {LH.Gatherer.Simulation.GraphNode} graph
   * @param {LH.Gatherer.Simulation.Simulator} simulator
   * @return {{wastedMs: number, results: Array<{url: string, wastedMs: number}>}}
   */
  static computeWasteWithGraph(lcpNode, graph, simulator) {
    const simulationBeforeChanges = simulator.simulate(graph, {flexibleOrdering: true});
    const modifiedGraph = graph.cloneWithRelationships();

    // Store the IDs of the LCP Node's dependencies for later
    /** @type {Set<string>} */
    const dependenciesIds = new Set();
    for (const node of lcpNode.getDependencies()) {
      dependenciesIds.add(node.id);
    }

    /** @type {LH.Gatherer.Simulation.GraphNode|null} */
    let modifiedLCPNode = null;
    /** @type {LH.Gatherer.Simulation.GraphNode|null} */
    let mainDocumentNode = null;
    modifiedGraph.traverse(node => {
      if (node.type !== 'network') return;

      const networkNode = /** @type {LH.Gatherer.Simulation.GraphNetworkNode} */ (node);
      if (node.isMainDocument()) {
        mainDocumentNode = networkNode;
      } else if (networkNode.record.url === lcpNode.record.url) {
        modifiedLCPNode = networkNode;
      }
    });

    if (!mainDocumentNode) {
      // Should always find the main document node
      throw new Error('Could not find main document node');
    }

    if (!modifiedLCPNode) {
      // Should always find the LCP node as well or else this function wouldn't have been called
      throw new Error('Could not find the LCP node');
    }

    modifiedLCPNode.removeAllDependencies();
    modifiedLCPNode.addDependency(mainDocumentNode);

    const simulationAfterChanges = simulator.simulate(modifiedGraph, {flexibleOrdering: true});
    const lcpTimingsBefore = simulationBeforeChanges.nodeTimings.get(lcpNode);
    const lcpTimingsAfter = simulationAfterChanges.nodeTimings.get(modifiedLCPNode);
    /** @type {Map<String, LH.Gatherer.Simulation.GraphNode>} */
    const modifiedNodesById = Array.from(simulationAfterChanges.nodeTimings.keys())
      .reduce((map, node) => map.set(node.id, node), new Map());
    const lcpEndTimeBefore = lcpTimingsBefore && lcpTimingsBefore.endTime || 0;
    const lcpEndTimeAfter = lcpTimingsAfter && lcpTimingsAfter.endTime || 0;

    let maxDependencyEndTime = 0;
    for (const nodeId of Array.from(dependenciesIds)) {
      const node = modifiedNodesById.get(nodeId);
      // @ts-expect-error node should never be undefined
      const timings = simulationAfterChanges.nodeTimings.get(node);
      const endTime = timings && timings.endTime || 0;
      maxDependencyEndTime = Math.max(maxDependencyEndTime, endTime);
    }

    const wastedMs = lcpEndTimeBefore - Math.max(lcpEndTimeAfter, maxDependencyEndTime);

    return {
      wastedMs,
      results: [{
        url: lcpNode.record.url,
        wastedMs,
      }],
    };
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const trace = artifacts.traces[PreloadLCPImageAudit.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[PreloadLCPImageAudit.DEFAULT_PASS];
    const URL = artifacts.URL;
    const simulatorOptions = {trace, devtoolsLog, settings: context.settings};
    const lcpElement = artifacts.TraceElements
      .find(element => element.traceEventType === 'largest-contentful-paint');

    const [mainResource, lanternLCP, simulator] = await Promise.all([
      MainResource.request({devtoolsLog, URL}, context),
      LanternLCP.request(simulatorOptions, context),
      LoadSimulator.request(simulatorOptions, context),
    ]);

    const graph = lanternLCP.pessimisticGraph;
    // eslint-disable-next-line max-len
    const lcpNode = PreloadLCPImageAudit.getLCPNodeToPreload(mainResource, graph, lcpElement, artifacts.ImageElements);
    if (!lcpNode) {
      return {
        score: 1,
        notApplicable: true,
      };
    }

    const {results, wastedMs} =
      PreloadLCPImageAudit.computeWasteWithGraph(lcpNode, graph, simulator);

    /** @type {LH.Audit.Details.Opportunity['headings']} */
    const headings = [
      {key: 'url', valueType: 'url', label: str_(i18n.UIStrings.columnURL)},
      {key: 'wastedMs', valueType: 'timespanMs', label: str_(i18n.UIStrings.columnWastedMs)},
    ];
    const details = Audit.makeOpportunityDetails(headings, results, wastedMs);

    return {
      score: UnusedBytes.scoreForWastedMs(wastedMs),
      numericValue: wastedMs,
      numericUnit: 'millisecond',
      displayValue: wastedMs ? str_(i18n.UIStrings.displayValueMsSavings, {wastedMs}) : '',
      details,
    };
  }
}

module.exports = PreloadLCPImageAudit;
module.exports.UIStrings = UIStrings;
