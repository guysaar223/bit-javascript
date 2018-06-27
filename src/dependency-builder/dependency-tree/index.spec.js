import assert from 'assert';
import sinon from 'sinon';
import mockfs from 'mock-fs';
import path from 'path';
import precinct from '../precinct';
import rewire from 'rewire';
import Config from './Config';

// Bootstrap lazy requires
import resolve from 'resolve';
import typescript from 'typescript';
import moduleDefinition from 'module-definition';

const dependencyTree = rewire('./');
const fixtures = path.resolve(`${__dirname}/../../../fixtures/dependency-tree`);

describe('dependencyTree', function() {
  this.timeout(8000);
  function testTreesForFormat(format, ext = '.js') {
    it('returns an object form of the dependency tree for a file', () => {
      const root = `${fixtures}/${format}`;
      const filename = `${root}/a${ext}`;

      const tree = dependencyTree({filename, root});

      assert(tree instanceof Object);

      const aSubTree = tree[filename];

      assert.ok(aSubTree instanceof Object);
      const filesInSubTree = Object.keys(aSubTree);

      assert.equal(filesInSubTree.length, 2);
    });
  }

  function mockStylus() {
    mockfs({
      [fixtures + '/stylus']: {
        'a.styl': `
          @import "b"
          @require "c.styl"
        `,
        'b.styl': '@import "c"',
        'c.styl': ''
      }
    });
  }

  function mockSass() {
    mockfs({
      [fixtures + '/sass']: {
        'a.scss': `
          @import "_b";
          @import "_c.scss";
        `,
        '_b.scss': 'body { color: blue; }',
        '_c.scss': 'body { color: pink; }'
      }
    });
  }

  function mockLess() {
    mockfs({
      [fixtures + '/less']: {
        'a.less': `
          @import "b.css";
          @import "c.less";
        `,
        'b.css': 'body { color: blue; }',
        'c.less': 'body { color: pink; }'
      }
    });
  }

  function mockes6() {
    mockfs({
      [fixtures + '/es6']: {
        'a.js': `
          import b from './b';
          import c from './c';
        `,
        'b.js': 'export default () => {};',
        'c.js': 'export default () => {};',
        'jsx.js': `import c from './c';\n export default <jsx />;`,
        'foo.jsx': `import React from 'react';\n import b from 'b';\n export default <jsx />;`,
        'es7.js': `import c from './c';\n export default async function foo() {};`
      }
    });
  }

  function mockTS() {
    mockfs({
      [fixtures + '/ts']: {
        'a.ts': `
          import b from './b';
          import c from './c';
        `,
        'b.ts': 'export default () => {};',
        'c.ts': 'export default () => {};'
      }
    });
  }

  afterEach(() => {
    mockfs.restore();
  });

  it('returns an empty object for a non-existent filename', () => {
    mockfs({
      imaginary: {}
    });

    const root = __dirname + '/imaginary';
    const filename = root + '/notafile.js';
    const tree = dependencyTree({filename, root});

    assert(tree instanceof Object);
    assert(!Object.keys(tree).length);
  });

  it('handles nested tree structures', () => {
    mockfs({
      [__dirname + '/extended']: {
        'a.js': `var b = require('./b');
                 var c = require('./c');`,
        'b.js': `var d = require('./d');
                 var e = require('./e');`,
        'c.js': `var f = require('./f');
                 var g = require('./g');`,
        'd.js': '',
        'e.js': '',
        'f.js': '',
        'g.js': ''
      }
    });

    const directory = __dirname + '/extended';
    const filename = directory + '/a.js';

    const tree = dependencyTree({filename, directory});
    assert(tree[filename] instanceof Object);

    // b and c
    const subTree = tree[filename];
    assert.equal(Object.keys(subTree).length, 2);

    const bTree = subTree[directory + '/b.js'];
    const cTree = subTree[directory + '/c.js'];
    // d and e
    assert.equal(Object.keys(bTree).length, 2);
    // f ang g
    assert.equal(Object.keys(cTree).length, 2);
  });

  it('does not include files that are not real (#13)', () => {
    mockfs({
      [__dirname + '/onlyRealDeps']: {
        'a.js': 'var notReal = require("./notReal");'
      }
    });

    const directory = __dirname + '/onlyRealDeps';
    const filename = directory + '/a.js';

    const tree = dependencyTree({filename, directory});
    const subTree = tree[filename];

    assert.ok(!Object.keys(subTree).some(dep => dep.indexOf('notReal') !== -1));
  });

  it('does not choke on cyclic dependencies', () => {
    mockfs({
      [__dirname + '/cyclic']: {
        'a.js': 'var b = require("./b");',
        'b.js': 'var a = require("./a");'
      }
    });

    const directory = __dirname + '/cyclic';
    const filename = directory + '/a.js';

    const spy = sinon.spy(dependencyTree, '_getDependencies');

    const tree = dependencyTree({filename, directory});

    assert(spy.callCount === 2);
    assert(Object.keys(tree[filename]).length);

    dependencyTree._getDependencies.restore();
  });

  it('excludes Nodejs core modules by default', () => {
    const directory = fixtures + '/commonjs';
    const filename = directory + '/b.js';

    const tree = dependencyTree({filename, directory});
    assert(Object.keys(tree[filename]).length === 0);
    assert(Object.keys(tree)[0].indexOf('b.js') !== -1);
  });

  it('traverses installed 3rd party node modules', () => {
    const directory = fixtures + '/onlyRealDeps';
    const filename = directory + '/a.js';

    const tree = dependencyTree({filename, directory});
    const subTree = tree[filename];

    assert(Object.keys(subTree).some(dep => dep === require.resolve('debug')));
  });

  it('returns a list of absolutely pathed files', () => {
    const directory = fixtures + '/commonjs';
    const filename = directory + '/b.js';

    const tree = dependencyTree({filename, directory});

    for (let node in tree.nodes) {
      assert(node.indexOf(process.cwd()) !== -1);
    }
  });

  it('excludes duplicate modules from the tree', () => {
    mockfs({
      root: {
        // More than one module includes c
        'a.js': `import b from "b";
                 import c from "c";`,
        'b.js': 'import c from "c";',
        'c.js': 'export default 1;'
      }
    });

    const tree = dependencyTree.toList({
      filename: 'root/a.js',
      directory: 'root'
    });

    assert(tree.length === 3);
  });

  describe('when given a detective configuration', () => {
    it('passes it through to precinct', () => {
      const spy = sinon.spy(precinct, 'paperwork');
      const directory = fixtures + '/onlyRealDeps';
      const filename = directory + '/a.js';
      const detectiveConfig = {
        amd: {
          skipLazyLoaded: true
        }
      };

      dependencyTree({
        filename,
        directory,
        detective: detectiveConfig
      });

      assert.ok(spy.calledWith(filename, detectiveConfig));
      spy.restore();
    });
  });

  describe('when given a list to store non existent partials', () => {
    describe('and the file contains no valid partials', () => {
      it('stores the invalid partials', () => {
        mockfs({
          [__dirname + '/onlyRealDeps']: {
            'a.js': 'var notReal = require("./notReal");'
          }
        });

        const directory = __dirname + '/onlyRealDeps';
        const filename = directory + '/a.js';
        const nonExistent = [];

        const tree = dependencyTree({filename, directory, nonExistent});

        assert.equal(Object.keys(nonExistent).length, 1);
        assert.equal(nonExistent[filename][0], './notReal');
      });
    });

    describe('and the file contains all valid partials', () => {
      it('does not store anything', () => {
        mockfs({
          [__dirname + '/onlyRealDeps']: {
            'a.js': 'var b = require("./b");',
            'b.js': 'export default 1;'
          }
        });

        const directory = __dirname + '/onlyRealDeps';
        const filename = directory + '/a.js';
        const nonExistent = [];

        const tree = dependencyTree({filename, directory, nonExistent});

        assert.equal(nonExistent.length, 0);
      });
    });

    describe('and the file contains a mix of invalid and valid partials', () => {
      it('stores the invalid ones', () => {
        mockfs({
          [__dirname + '/onlyRealDeps']: {
            'a.js': 'var b = require("./b");',
            'b.js': 'var c = require("./c"); export default 1;',
            'c.js': 'var crap = require("./notRealMan");'
          }
        });

        const directory = __dirname + '/onlyRealDeps';
        const filename = directory + '/a.js';
        const nonExistent = [];

        const tree = dependencyTree({filename, directory, nonExistent});

        assert.equal(Object.keys(nonExistent).length, 1);
        assert.equal(nonExistent[`${directory}/c.js`][0], './notRealMan');
      });
    });

    describe('and there is more than one reference to the invalid partial', () => {
      it('should include the non-existent partial per file', () => {
        mockfs({
          [__dirname + '/onlyRealDeps']: {
            'a.js': 'var b = require("./b");\nvar crap = require("./notRealMan");',
            'b.js': 'var c = require("./c"); export default 1;',
            'c.js': 'var crap = require("./notRealMan");'
          }
        });

        const directory = __dirname + '/onlyRealDeps';
        const filename = directory + '/a.js';
        const nonExistent = [];

        const tree = dependencyTree({filename, directory, nonExistent});

        assert.equal(Object.keys(nonExistent).length, 2);
        assert.equal(nonExistent[filename][0], './notRealMan');
        assert.equal(nonExistent[`${directory}/c.js`][0], './notRealMan');
      });
    });
  });

  describe('throws', () => {
    beforeEach(() => {
      this._directory = fixtures + '/commonjs';
      this._revert = dependencyTree.__set__('traverse', () => []);
    });

    afterEach(() => {
      this._revert();
    });

    it('throws if the filename is missing', () => {
      assert.throws(() => {
        dependencyTree({
          filename: undefined,
          directory: this._directory
        });
      });
    });

    it('throws if the root is missing', () => {
      assert.throws(() => {
        dependencyTree({filename});
      });
    });

    it('throws if a supplied filter is not a function', () => {
      assert.throws(() => {
        const directory = fixtures + '/onlyRealDeps';
        const filename = directory + '/a.js';

        const tree = dependencyTree({
          filename,
          directory,
          filter: 'foobar'
        });
      });
    });

    it('does not throw on the legacy `root` option', () => {
      assert.doesNotThrow(() => {
        const directory = fixtures + '/onlyRealDeps';
        const filename = directory + '/a.js';

        const tree = dependencyTree({
          filename,
          root: directory
        });
      });
    });
  });

  describe('on file error', () => {
    beforeEach(() => {
      this._directory = fixtures + '/commonjs';
    });

    it('does not throw', () => {
      assert.doesNotThrow(() => {
        dependencyTree({
          filename: 'foo',
          directory: this._directory
        });
      });
    });

    it('returns no dependencies', () => {
      const tree = dependencyTree({filename: 'foo', directory: this._directory});
      assert(!tree.length);
    });
  });

  describe('memoization (#2)', () => {
    beforeEach(() => {
      this._spy = sinon.spy(dependencyTree, '_getDependencies');
    });

    afterEach(() => {
      dependencyTree._getDependencies.restore();
    });

    it('accepts a cache object for memoization (#2)', () => {
      const filename = fixtures + '/amd/a.js';
      const directory = fixtures + '/amd';
      const cache = {};

      cache[fixtures + '/amd/b.js'] = [
        fixtures + '/amd/b.js',
        fixtures + '/amd/c.js'
      ];

      const tree = dependencyTree({
        filename,
        directory,
        visited: cache
      });

      assert.equal(Object.keys(tree[filename]).length, 2);
      assert(this._spy.neverCalledWith(fixtures + '/amd/b.js'));
    });

    it('returns the precomputed list of a cached entry point', () => {
      const filename = fixtures + '/amd/a.js';
      const directory = fixtures + '/amd';

      const cache = {
        // Shouldn't process the first file's tree
        [filename]: []
      };

      const tree = dependencyTree({
        filename,
        directory,
        visited: cache
      });

      assert(!tree.length);
    });
  });

  describe('module formats', () => {
    describe('amd', () => {
      testTreesForFormat('amd');
    });

    describe('commonjs', () => {
      testTreesForFormat('commonjs');
    });

    describe('es6', () => {
      beforeEach(() => {
        this._directory = fixtures + '/es6';
        mockes6();
      });

      testTreesForFormat('es6');

      it('resolves files that have jsx', () => {
        const filename = `${this._directory}/jsx.js`;
        const {[filename]: tree} = dependencyTree({
          filename,
          directory: this._directory
        });

        assert.ok(tree[`${this._directory}/c.js`]);
      });

      it('resolves files with a jsx extension', () => {
        const filename = `${this._directory}/foo.jsx`;
        const {[filename]: tree} = dependencyTree({
          filename,
          directory: this._directory
        });

        assert.ok(tree[`${this._directory}/b.js`]);
      });

      it('resolves files that have es7', () => {
        const filename = `${this._directory}/es7.js`;
        const {[filename]: tree} = dependencyTree({
          filename,
          directory: this._directory
        });

        assert.ok(tree[`${this._directory}/c.js`]);
      });
    });

    describe('sass', () => {
      beforeEach(() => {
        mockSass();
      });

      testTreesForFormat('sass', '.scss');
    });

    describe('stylus', () => {
      beforeEach(() => {
        mockStylus();
      });

      testTreesForFormat('stylus', '.styl');
    });

    describe('less', () => {
      beforeEach(() => {
        mockLess();
      });

      testTreesForFormat('less', '.less');
    });

    describe('typescript', () => {
      beforeEach(() => {
        mockTS();
      });

      testTreesForFormat('ts', '.ts');
    });
  });

  // @todo fix.
  describe.skip('webpack', () => {
    beforeEach(() => {
      // Note: not mocking because webpack's resolver needs a real project with dependencies;
      // otherwise, we'd have to mock a ton of files.
      this._root = path.join(__dirname, '../');
      this._webpackConfig = this._root + '/webpack.config.js';

      this._testResolution = name => {
        const results = dependencyTree.toList({
          filename: `${fixtures}/webpack/${name}.js`,
          directory: this._root,
          webpackConfig: this._webpackConfig,
          filter: filename => filename.indexOf('filing-cabinet') !== -1
        });
        assert.ok(results.some(filename => filename.indexOf('node_modules/filing-cabinet') !== -1));
      };
    });

    it('resolves aliased modules', () => {
      this.timeout(5000);
      this._testResolution('aliased');
    });

    it('resolves unaliased modules', () => {
      this.timeout(5000);
      this._testResolution('unaliased');
    });
  });

  describe('requirejs', () => {
    beforeEach(() => {
      mockfs({
        root: {
          'lodizzle.js': 'define({})',
          'require.config.js': `
            requirejs.config({
              baseUrl: './',
              paths: {
                F: './lodizzle.js'
              }
            });
          `,
          'a.js': `
            define([
              'F'
            ], function(F) {

            });
          `,
          'b.js': `
            define([
              './lodizzle'
            ], function(F) {

            });
          `
        }
      });
    });

    it('resolves aliased modules', () => {
      const tree = dependencyTree({
        filename: 'root/a.js',
        directory: 'root',
        config: 'root/require.config.js'
      });

      const filename = path.resolve(process.cwd(), 'root/a.js');
      const aliasedFile = path.resolve(process.cwd(), 'root/lodizzle.js');
      assert.ok('root/lodizzle.js' in tree[filename]);
    });

    it('resolves non-aliased paths', () => {
      const tree = dependencyTree({
        filename: 'root/b.js',
        directory: 'root',
        config: 'root/require.config.js'
      });

      const filename = path.resolve(process.cwd(), 'root/b.js');
      const aliasedFile = path.resolve(process.cwd(), 'root/lodizzle.js');
      assert.ok('root/lodizzle.js' in tree[filename]);
    });
  });

  describe('when a filter function is supplied', () => {
    it('uses the filter to determine if a file should be included in the results', () => {
      const directory = fixtures + '/onlyRealDeps';
      const filename = directory + '/a.js';

      const tree = dependencyTree({
        filename,
        directory,
        // Skip all 3rd party deps
        filter: (filePath, moduleFile) => {
          assert.ok(require.resolve('debug'));
          assert.ok(moduleFile.match('onlyRealDeps/a.js'));
          return filePath.indexOf('node_modules') === -1;
        }
      });

      const subTree = tree[filename];
      assert.ok(Object.keys(tree).length);

      const has3rdPartyDep = Object.keys(subTree).some(dep => dep === require.resolve('debug'));
      assert.ok(!has3rdPartyDep);
    });
  });

  describe('when given a CJS file with lazy requires', () => {
    beforeEach(() => {
      mockfs({
        [__dirname + '/cjs']: {
          'foo.js': 'module.exports = function(bar = require("./bar")) {};',
          'bar.js': 'module.exports = 1;'
        }
      });
    });

    it('includes the lazy dependency', () => {
      const directory = __dirname + '/cjs';
      const filename = directory + '/foo.js';

      const tree = dependencyTree({filename, directory});
      const subTree = tree[filename];

      assert.ok(`${directory}/bar.js` in subTree);
    });
  });

  describe('when given an es6 file using CJS lazy requires', () => {
    beforeEach(() => {
      mockfs({
        [__dirname + '/es6']: {
          'foo.js': 'export default function(bar = require("./bar")) {};',
          'bar.js': 'export default 1;'
        }
      });
    });

    describe('and mixedImport mode is turned on', () => {
      it('includes the lazy dependency', () => {
        const directory = __dirname + '/es6';
        const filename = directory + '/foo.js';

        const tree = dependencyTree({
          filename,
          directory,
          detective: {
            es6: {
              mixedImports: true
            }
          }
        });

        const subTree = tree[filename];

        assert.ok(`${directory}/bar.js` in subTree);
      });

      it('also works for toList', () => {
        const directory = __dirname + '/es6';
        const filename = directory + '/foo.js';

        const results = dependencyTree.toList({
          filename,
          directory,
          detective: {
            es6: {
              mixedImports: true
            }
          }
        });

        assert.equal(results[0], `${directory}/bar.js`);
        assert.equal(results[1], filename);
      });
    });
  });

  describe('when given an es6 file using dynamic imports', () => {
    beforeEach(() => {
      mockfs({
        [__dirname + '/es6']: {
          'foo.js': 'import("./bar");',
          'bar.js': 'export default 1;'
        }
      });
    });

    it('includes the dynamic import', () => {
      const directory = __dirname + '/es6';
      const filename = directory + '/foo.js';

      const tree = dependencyTree({
        filename,
        directory
      });

      const subTree = tree[filename];

      assert.ok(!(`${directory}/bar.js` in subTree));
    });
  });

  describe('when given a CJS file with module property in package.json', () => {
    beforeEach(() => {
      mockfs({
        [__dirname + '/es6']: {
          ['module.entry.js']: 'import * as module from "module.entry"',
          ['node_modules']: {
            ['module.entry']: {
              'index.main.js': 'module.exports = () => {};',
              'index.module.js': 'module.exports = () => {};',
              'package.json': '{ "main": "index.main.js", "module": "index.module.js" }'
            }
          }
        }
      });
    });

    // @todo: fix. why the main is module and not main?
    it.skip('it includes the module entry as dependency', () => {
      const directory = __dirname + '/es6';
      const filename = directory + '/module.entry.js';

      const tree = dependencyTree({
        filename,
        directory,
        nodeModulesConfig: {
          entry: 'module'
        }
      });
      const subTree = tree[filename];

      assert.ok(`${directory}/node_modules/module.entry/index.module.js` in subTree);
    });
  });

  describe('Config', () => {
    describe('when cloning', () => {
      describe('and a detective config was set', () => {
        it('retains the detective config in the clone', () => {
          const detectiveConfig = {
            es6: {
              mixedImports: true
            }
          };

          const config = new Config({
            detectiveConfig,
            filename: 'foo',
            directory: 'bar'
          });

          const clone = config.clone();

          assert.deepEqual(clone.detectiveConfig, detectiveConfig);
        });
      });
    });
  });
});