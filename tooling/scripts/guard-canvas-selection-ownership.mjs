#!/usr/bin/env node
import {
  compilePathPolicy,
  createIssue,
  createSourceFile,
  runIssuesMain,
  ts,
} from './policy-scan-utils.mjs';

const DEFAULT_POLICY_PATH = 'tooling/policies/canvas-selection-ownership.policy.json';

const DEFAULT_FORBIDDEN_STORE_ACTIONS = [
  'selectNode',
  'selectNodes',
  'selectEdge',
  'selectEdges',
  'selectGroup',
  'selectAnnotation',
  'selectAnnotations',
  'selectAll',
  'clearSelection',
  'requestNodeSelection',
  'requestEdgeSelection',
  'requestClearSelection',
  'consumeSelectionRequest',
  'selectionRequest',
];

const RULES = {
  legacyStoreAction: {
    id: 'canvas-selection/no-legacy-store-selection-access',
    message: 'Canvas selection owner 已切到 command provider，禁止再通过 useCanvasStore 读取旧 selection action。',
    suggestion: '改用 CanvasSelectionCommandProvider / useCanvasSelectionCommands，或使用 projectSelectionContract 投影正式选择状态。',
  },
  legacySelectedField: {
    id: 'canvas-selection/no-legacy-selected-steady-state',
    message: 'steady-state GraphNode/GraphEdge/clipboard fixture 禁止回流 legacy selected 字段。',
    suggestion: '从业务节点/边 fixture 中删除 selected；ReactFlow runtime selected 仅保留在 flow payload / change payload 测试层。',
  },
  legacySelectedSlotIds: {
    id: 'canvas-selection/no-legacy-result-area-selected-slot-ids',
    message: 'steady-state resultArea.data 禁止回流 selectedSlotIds。',
    suggestion: '正式持久化字段改用 outputSlotIds；selectedSlotIds 只允许停留在 migration/load 边界或 UI session/layout 层。',
  },
};

const compilePolicy = (policy) => ({
  ...compilePathPolicy(policy),
  forbiddenStoreActions: new Set(policy.forbiddenStoreActions ?? DEFAULT_FORBIDDEN_STORE_ACTIONS),
});

const getPropertyName = (node) => {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return '';
};

const objectHasProperty = (objectLiteral, propertyName) =>
  objectLiteral.properties.some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
      return false;
    }
    return getPropertyName(property.name) === propertyName;
  });

const isGraphNodeLikeObject = (objectLiteral) =>
  objectHasProperty(objectLiteral, 'id') &&
  objectHasProperty(objectLiteral, 'type') &&
  objectHasProperty(objectLiteral, 'position') &&
  objectHasProperty(objectLiteral, 'data') &&
  objectHasProperty(objectLiteral, 'inputs') &&
  objectHasProperty(objectLiteral, 'outputs');

const isGraphEdgeLikeObject = (objectLiteral) =>
  objectHasProperty(objectLiteral, 'id') &&
  objectHasProperty(objectLiteral, 'source') &&
  objectHasProperty(objectLiteral, 'sourcePort') &&
  objectHasProperty(objectLiteral, 'target') &&
  objectHasProperty(objectLiteral, 'targetPort');

const isUseCanvasStoreCall = (node) => ts.isIdentifier(node.expression) && node.expression.text === 'useCanvasStore';

const isUseCanvasStoreGetStateCall = (node, sourceFile) => {
  if (!ts.isCallExpression(node)) return false;
  return node.expression.getText(sourceFile) === 'useCanvasStore.getState';
};

const scanLegacyStoreSelector = (sourceFile, relPath, selector, forbiddenStoreActions) => {
  const issues = [];
  const parameter = selector.parameters[0];
  if (!parameter || !ts.isIdentifier(parameter.name)) return issues;
  const parameterName = parameter.name.text;

  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === parameterName &&
      forbiddenStoreActions.has(node.name.text)
    ) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          RULES.legacyStoreAction.id,
          RULES.legacyStoreAction.message,
          RULES.legacyStoreAction.suggestion,
        ),
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(selector.body);
  return issues;
};

const scanFile = ({ absPath, relPath }, policy) => {
  const sourceFile = createSourceFile(absPath);
  const issues = [];

  const visit = (node) => {
    if (ts.isCallExpression(node) && isUseCanvasStoreCall(node)) {
      const selector = node.arguments[0];
      if (selector && (ts.isArrowFunction(selector) || ts.isFunctionExpression(selector))) {
        issues.push(...scanLegacyStoreSelector(sourceFile, relPath, selector, policy.forbiddenStoreActions));
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      policy.forbiddenStoreActions.has(node.name.text) &&
      isUseCanvasStoreGetStateCall(node.expression, sourceFile)
    ) {
      issues.push(
        createIssue(
          sourceFile,
          relPath,
          node,
          RULES.legacyStoreAction.id,
          RULES.legacyStoreAction.message,
          RULES.legacyStoreAction.suggestion,
        ),
      );
    }

    if (ts.isPropertyAssignment(node) && getPropertyName(node.name) === 'selected') {
      const objectLiteral = ts.isObjectLiteralExpression(node.parent) ? node.parent : null;
      if (objectLiteral && (isGraphNodeLikeObject(objectLiteral) || isGraphEdgeLikeObject(objectLiteral))) {
        issues.push(
          createIssue(
            sourceFile,
            relPath,
            node,
            RULES.legacySelectedField.id,
            RULES.legacySelectedField.message,
            RULES.legacySelectedField.suggestion,
          ),
        );
      }
    }

    if (ts.isPropertyAssignment(node) && getPropertyName(node.name) === 'selectedSlotIds') {
      const objectLiteral = ts.isObjectLiteralExpression(node.parent) ? node.parent : null;
      const parentProperty =
        objectLiteral && ts.isPropertyAssignment(objectLiteral.parent) ? objectLiteral.parent : null;
      const parentPropertyName = parentProperty ? getPropertyName(parentProperty.name) : '';
      if (objectLiteral && (objectHasProperty(objectLiteral, 'slots') || parentPropertyName === 'data')) {
        issues.push(
          createIssue(
            sourceFile,
            relPath,
            node,
            RULES.legacySelectedSlotIds.id,
            RULES.legacySelectedSlotIds.message,
            RULES.legacySelectedSlotIds.suggestion,
          ),
        );
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return issues;
};

runIssuesMain({
  title: 'Canvas selection ownership gate',
  defaultPolicyPath: DEFAULT_POLICY_PATH,
  compilePolicy,
  scanFile,
});
