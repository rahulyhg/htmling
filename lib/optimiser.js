'use strict';
var fast = require('fast.js'),
    traverse = require('./traverse');

/**
 * Optimise the given AST.
 *
 * @param  {Object} ast The AST to optimise.
 * @return {Object}     The optimised AST.
 */
exports.optimise = function (ast) {
  ast = removeNestedBlocks(ast);
  ast = hoistFunctions(ast);
  ast = removeUnusedAssignmentExpressions(ast);
  ast = replaceContextReferences(ast);
  ast = removeUnusedVariableDeclarators(ast);
  ast = combineContiguousOutputStatements(ast);
  ast = normalizeFirstOutputStatement(ast);
  return ast;
};

/**
 * Remove pointless nested BlockStatements that are caused by the compilation process.
 */
function removeNestedBlocks (ast) {
  var tagged;
  while((tagged = findNestedBlocks(ast)).length) {
    fast.forEach(tagged, function (item) {
      var node = item[0],
          parent = item[1],
          index = parent.body.indexOf(node);
      fast.apply(Array.prototype.splice, parent.body, fast.concat([index, 1], node.body));
    });
  }
  return ast;
}

/**
 * Find BlockStatements which are direct children of BlockStatements.
 */
function findNestedBlocks (ast) {
  var tagged = [];
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type === 'BlockStatement' && parent && parent.type === 'BlockStatement') {
        tagged.push([node, parent]);
      }
    }
  });
  return tagged;
}

/**
 * Hoist tagged functions (a $ in the name) out of the `render()` method.
 */
function hoistFunctions (ast) {
  var tagged = findHoistableFunctionDeclarations(ast);
  fast.forEach(tagged, function (item) {
    var node = item[0],
        parent = item[1],
        index = parent.body.indexOf(node);
    ast.body.unshift(node);
    parent.body.splice(index, 1);
  });
  return ast;
}

/**
 * Find function declarations which can be hoisted,
 */
function findHoistableFunctionDeclarations (ast) {
  var tagged = [];
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type === 'FunctionDeclaration' && ~node.id.name.indexOf('$')) {
        tagged.push([node, parent]);
      }
    }
  });

  return tagged;
}

/**
 * If the first output statement is not in a branch, make it a
 * direct assignment (`=`) rather than `+=`. And remove the initial value
 * from the `html` declarator. This optimisation pass is specifically designed
 * to upset @jdalton.
 */
function normalizeFirstOutputStatement (ast) {
  var replaceable;
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type !== 'Identifier' || node.name !== 'html') {
        return;
      }
      if (parent.type === 'VariableDeclarator') {
        replaceable = parent;
        var scope = findScope(ast, parent);
        traverse.traverse(scope, {
          enter: function (node, parent) {
            if (node.type === 'ForStatement' ||
                node.type === 'FunctionDeclaration' ||
                node.type === 'FunctionExpression' ||
                node.type === 'IfStatement'
            ) {
              this.break();
            }
            else if (node.type === 'Identifier' &&
                     node.name === 'html' &&
                     parent.type === 'AssignmentExpression' &&
                     parent.operator === '+='
            ) {
              parent.operator = '=';
              replaceable.init = null;
              this.break();
            }
          }
        });
      }
    }
  });
  return ast;
}

/**
 * Turn sequential OutputStatements into one big one.
 */
function combineContiguousOutputStatements (ast) {
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type !== 'BlockStatement') {
        return;
      }
      var prev = false;

      node.body = fast.reduce(node.body, function (body, statement) {
        if (
          !body.length ||
          statement.type !== 'ExpressionStatement' ||
          statement.expression.type !== 'AssignmentExpression' ||
          statement.expression.operator !== '+=' ||
          statement.expression.left.type !== 'Identifier' ||
          statement.expression.left.name !== 'html'
        ) {
          prev = false;
          body.push(statement);
          return body;
        }
        else if (!prev) {
          prev = statement;
          body.push(statement);
          return body;
        }
        prev.expression.right = {
          type: 'BinaryExpression',
          operator: '+',
          left: prev.expression.right,
          right: statement.expression.right
        };
        return body;
      }, []);
    }
  });
  return ast;
}

/**
 * If the result of an AssignmentExpression is not used, remove the
 * expression entirely.
 */
function removeUnusedAssignmentExpressions (ast) {
  var unused = findUnusedAssignmentExpressions(ast);
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type !== 'BlockStatement') {
        return;
      }
      node.body = fast.filter(node.body, function (item) {
        return !~fast.indexOf(unused, item);
      });
    }
  });
  return ast;
}

/**
 * Find AssignmentExpression whose result is not used.
 */
function findUnusedAssignmentExpressions (ast) {
 var unused = [];
  traverse.traverse(ast, {
    enter: function (node, parent) {
      var scope, refs;
      if (parent &&
          parent.type === 'ExpressionStatement' &&
          node.type === 'AssignmentExpression' &&
          node.operator === '=' &&
          node.left.type === 'Identifier' &&
          (scope = findScope(ast, parent))
      ) {
        refs = fast.filter(findVariableReferences(scope, node.left, parent), function (item) {
          return item !== node.left;
        });
        if (!refs.length) {
          unused.push(parent); // the whole ExpressionStatement should be removed, not just the assignment.
        }
      }
    }
  });
  return unused;
}


/**
 * If a variable is declared, but not used, remove it.
 */
function removeUnusedVariableDeclarators (ast) {
  var unused = findUnusedVariableDeclarators(ast);
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type !== 'VariableDeclaration') {
        return;
      }
      node.declarations = fast.filter(node.declarations, function (item) {
        return !~fast.indexOf(unused, item);
      });
    }
  });
  return ast;
}

/**
 * Find declarators of unused variables.
 */
function findUnusedVariableDeclarators (ast) {
  var unused = [];
  traverse.traverse(ast, {
    enter: function (node, parent) {
      var scope, refs;
      if (node.type === 'VariableDeclarator' && (scope = findScope(ast, node))) {
        refs = fast.filter(findVariableReferences(scope, node.id), function (item) {
          return item !== node.id;
        });

        if (!refs.length) {
          unused.push(node);
        }
      }
    }
  });
  return unused;
}

/**
 * Find references to a given identifier
 */
function findVariableReferences (ast, identifier, skip) {
  var references = [];
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node === skip) {
        this.skip();
      }
      else if (
          node.type === 'Identifier' &&
          node.name === identifier.name &&
          (parent.type !== 'MemberExpression' || parent.left !== node)
      ) {
        references.push(node);
      }
    }
  });
  return references;
}

/**
 * Find the scope for an item in the AST.
 */
function findScope (ast, item) {
  var scopes = [],
      found = false;
  traverse.traverse(ast, {
    enter: function (node, parent) {
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
        scopes.push(node);
      }
      else if (node === item) {
        found = scopes[scopes.length - 1];
        this.break();
      }
    },
    leave: function (node, parent) {
      if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
        scopes.pop();
      }
    }
  });
  return found ? found.body : false;
}

function replaceContextReferences (ast) {
  traverse.traverse(ast, { enter: function (node) {
    if (node.type === 'FunctionExpression') {
      this.skip();
      traverse.traverse(node, {
        enter: function (item, parent) {
          if (item !== node && (item.type === 'FunctionExpression' || item.type === 'FunctionDeclaration')) {
            this.skip();
          }
          else if (
            item.type === 'Identifier' &&
            item.name === 'context' &&
            (!parent || parent.type !== 'VariableDeclarator')
          ) {
            item.name = 'this';
          }
        }
      });
    }
    else if (node.type === 'FunctionDeclaration') {
      this.skip();
    }
  }});
  return ast;
}