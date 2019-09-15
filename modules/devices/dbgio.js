/**
 * @fileoverview Basic debugger services
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @copyright © 2012-2019 Jeff Parsons
 *
 * This file is part of PCjs, a computer emulation software project at <https://www.pcjs.org>.
 *
 * PCjs is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 *
 * PCjs is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
 * even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with PCjs.  If not,
 * see <http://www.gnu.org/licenses/gpl.html>.
 *
 * You are required to include the above copyright notice in every modified copy of this work
 * and to display that copyright notice when the software starts running; see COPYRIGHT in
 * <https://www.pcjs.org/modules/devices/machine.js>.
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of PCjs
 * for purposes of the GNU General Public License, and the author does not claim any copyright
 * as to their contents.
 */

"use strict";

/**
 * @typedef {Object} Address
 * @property {number} off
 * @property {number} seg
 * @property {number} type
 */

/**
 * Basic debugger services
 *
 * @class {DbgIO}
 * @unrestricted
 */
class DbgIO extends Device {
    /**
     * DbgIO(idMachine, idDevice, config)
     *
     * @this {DbgIO}
     * @param {string} idMachine
     * @param {string} idDevice
     * @param {Config} [config]
     */
    constructor(idMachine, idDevice, config)
    {
        super(idMachine, idDevice, config);

        /*
         * Default base (radix).
         */
        this.nDefaultBase = 16;

        /*
         * Default endian (0 = little, 1 = big).
         */
        this.nDefaultEndian = 0;

        /*
         * Default maximum instruction (opcode) length, overridden by the CPU-specific debugger.
         */
        this.maxOpLength = 1;

        /*
         * Default subexpression and address delimiters.
         */
        this.achGroup = ['(',')'];
        this.achAddress = ['[',']'];

        /*
         * This controls how we stop the CPU on a break condition.  If fBreakException is true, we'll
         * throw an exception, which the CPU will catch and halt; however, the downside of that approach
         * is that, in some cases, it may leave the CPU in an inconsistent state.  It's generally safer
         * to leave fBreakException false, which will still stop the clock, allowing the current instruction
         * to finish executing.
         */
        this.fBreakException = false;

        /*
         * aVariables is an object with properties that grow as setVariable() assigns more variables;
         * each property corresponds to one variable, where the property name is the variable name (ie,
         * a string beginning with a non-digit, followed by zero or more symbol characters and/or digits)
         * and the property value is the variable's numeric value.  See doVar() and setVariable() for
         * details.
         *
         * Note that parseValue() parses variables before numbers, so any variable that looks like a
         * unprefixed hex value (eg, "a5" as opposed to "0xa5") will trump the numeric value.  Unprefixed
         * hex values are a convenience of parseValue(), which always calls parseInt() with a default
         * base of 16; however, that default be overridden with a variety of explicit prefixes or suffixes
         * (eg, a leading "0o" to indicate octal, a trailing period to indicate decimal, etc.)
         *
         * See parseInt() for more details about supported numbers.
         */
        this.aVariables = {};

        /*
         * Since we want to be able to clear/disable/enable/list break addresses by index number, we will
         * merely set cleared entries to undefined, rather than splicing them out, and when setting new entries,
         * we will scan for the first available slot.  As for which ones are disabled, that will be handled by
         * adding TWO_POW32 to the address; machine performance will still be affected, because any block(s) with
         * break addresses will still be trapping accesses, so you should clear break addresses whenever possible.
         */
        this.aBreakReadAddr = [];
        this.aBreadWriteAddr = [];
        this.readBusCheck = this.checkBusRead.bind(this);
        this.writeBusCheck = this.checkBusWrite.bind(this);

        /*
         * Get access to the CPU, in part so we can connect to all its registers.
         */
        this.cpu = /** @type {CPU} */ (this.findDeviceByClass(Machine.CLASS.CPU));
        this.registers = this.cpu.registers;

        /*
         * Get access to the Bus devices, so we have access to the I/O and memory address spaces.
         *
         * To minimize configuration redundancy, we rely on the CPU's configuration to get the Bus device IDs.
         */
        this.busIO = /** @type {Bus} */ (this.findDevice(this.cpu.config['busIO']));
        this.busMemory = /** @type {Bus} */ (this.findDevice(this.cpu.config['busMemory']));
        this.nDefaultBits = this.busMemory.addrWidth;

        /*
         * Get access to the Time device, so we can stop and start time as needed.
         */
        this.time = /** @type {Time} */ (this.findDeviceByClass(Machine.CLASS.TIME));

        /*
         * Initialize all properties required for our onCommand() handler.
         */
        this.addressPrev = this.newAddress();
        this.historyNext = 0;
        this.historyBuffer = [];
        this.addHandler(Device.HANDLER.COMMAND, this.onCommand.bind(this));
    }

    /**
     * delVariable(sVar)
     *
     * @this {DbgIO}
     * @param {string} sVar
     */
    delVariable(sVar)
    {
        delete this.aVariables[sVar];
    }

    /**
     * getVariable(sVar)
     *
     * @this {DbgIO}
     * @param {string} sVar
     * @return {number|undefined}
     */
    getVariable(sVar)
    {
        if (this.aVariables[sVar]) {
            return this.aVariables[sVar].value;
        }
        sVar = sVar.substr(0, 6);
        return this.aVariables[sVar] && this.aVariables[sVar].value;
    }

    /**
     * getVariableFixup(sVar)
     *
     * @this {DbgIO}
     * @param {string} sVar
     * @return {string|undefined}
     */
    getVariableFixup(sVar)
    {
        return this.aVariables[sVar] && this.aVariables[sVar].sUndefined;
    }

    /**
     * isVariable(sVar)
     *
     * @this {DbgIO}
     * @param {string} sVar
     * @return {boolean}
     */
    isVariable(sVar)
    {
        return this.aVariables[sVar] !== undefined;
    }

    /**
     * resetVariables()
     *
     * @this {DbgIO}
     * @return {Object}
     */
    resetVariables()
    {
        let a = this.aVariables;
        this.aVariables = {};
        return a;
    }

    /**
     * restoreVariables(a)
     *
     * @this {DbgIO}
     * @param {Object} a (from previous resetVariables() call)
     */
    restoreVariables(a)
    {
        this.aVariables = a;
    }

    /**
     * setVariable(sVar, value, sUndefined)
     *
     * @this {DbgIO}
     * @param {string} sVar
     * @param {number} value
     * @param {string|undefined} [sUndefined]
     */
    setVariable(sVar, value, sUndefined)
    {
        this.aVariables[sVar] = {value, sUndefined};
    }

    /**
     * addAddress(address, offset)
     *
     * All this function currently supports are physical (Bus) addresses, but that will change.
     *
     * @this {DbgIO}
     * @param {Address} address
     * @param {number} offset
     * @return {Address}
     */
    addAddress(address, offset)
    {
        address.off = (address.off + offset) & this.busMemory.addrLimit;
        return address;
    }

    /**
     * displayAddress(address)
     *
     * All this function currently supports are physical (Bus) addresses, but that will change.
     *
     * @this {DbgIO}
     * @param {Address} address
     * @return {string}
     */
    displayAddress(address)
    {
        return this.toBase(address.off, this.nDefaultBase, this.busMemory.addrWidth);
    }

    /**
     * newAddress(init)
     *
     * All this function currently supports are physical (Bus) addresses, but that will change.
     *
     * @this {DbgIO}
     * @param {Address|number} [init]
     * @return {Address}
     */
    newAddress(init = 0)
    {
        let seg = -1, type = DbgIO.ADDRESS.PHYSICAL;
        if (typeof init == "number") return {off: init, seg, type};
        return {off: init.off, seg: init.seg, type: init.type};
    }

    /**
     * parseAddress(sAddress)
     *
     * @this {DbgIO}
     * @param {string} sAddress
     * @return {Address|undefined}
     */
    parseAddress(sAddress)
    {
        let address;
        if (sAddress) {
            let iOff = 0;
            let ch = sAddress.charAt(iOff);

            address = this.newAddress();

            switch(ch) {
            case '&':
                iOff++;
                break;
            case '#':
                iOff++;
                address.type = DbgIO.ADDRESS.PROTECTED;
                break;
            case '%':
                iOff++;
                ch = sAddress.charAt(iOff);
                if (ch == '%') {
                    iOff++;
                } else {
                    address.type = DbgIO.ADDRESS.LINEAR;
                }
                break;
            }

            let iColon = sAddress.indexOf(':');
            if (iColon >= 0) {
                let seg = this.parseExpression(sAddress.substring(iOff, iColon));
                if (seg != undefined) address.seg = seg;
                iOff = iColon + 1;
            }
            address.off = this.parseExpression(sAddress.substring(iOff)) || 0;
        }
        return address;
    }

    /**
     * readAddress(address, advance)
     *
     * All this function currently supports are physical (Bus) addresses, but that will change.
     *
     * @this {DbgIO}
     * @param {Address} address
     * @param {number} [advance] (amount to advance address after read, if any)
     * @return {number|undefined}
     */
    readAddress(address, advance)
    {
        let value = this.busMemory.readData(address.off);
        if (advance) this.addAddress(address, advance);
        return value;
    }

    /**
     * writeAddress(address, value)
     *
     * All this function currently supports are physical (Bus) addresses, but that will change.
     *
     * @this {DbgIO}
     * @param {Address} address
     * @param {number} value
     */
    writeAddress(address, value)
    {
        this.busMemory.writeData(address.off, value);
    }

    /**
     * evalAND(dst, src)
     *
     * Adapted from /modules/pdp10/lib/cpuops.js:PDP10.AND().
     *
     * Performs the bitwise "and" (AND) of two operands > 32 bits.
     *
     * @this {DbgIO}
     * @param {number} dst
     * @param {number} src
     * @return {number} (dst & src)
     */
    evalAND(dst, src)
    {
        /*
         * We AND the low 32 bits separately from the higher bits, and then combine them with addition.
         * Since all bits above 32 will be zero, and since 0 AND 0 is 0, no special masking for the higher
         * bits is required.
         *
         * WARNING: When using JavaScript's 32-bit operators with values that could set bit 31 and produce a
         * negative value, it's critical to perform a final right-shift of 0, ensuring that the final result is
         * positive.
         */
        if (this.nDefaultBits <= 32) {
            return dst & src;
        }
        /*
         * Negative values don't yield correct results when dividing, so pass them through an unsigned truncate().
         */
        dst = this.truncate(dst, 0, true);
        src = this.truncate(src, 0, true);
        return ((((dst / NumIO.TWO_POW32)|0) & ((src / NumIO.TWO_POW32)|0)) * NumIO.TWO_POW32) + ((dst & src) >>> 0);
    }

    /**
     * evalMUL(dst, src)
     *
     * I could have adapted the code from /modules/pdp10/lib/cpuops.js:PDP10.doMUL(), but it was simpler to
     * write this base method and let the PDP-10 Debugger override it with a call to the *actual* doMUL() method.
     *
     * @this {DbgIO}
     * @param {number} dst
     * @param {number} src
     * @return {number} (dst * src)
     */
    evalMUL(dst, src)
    {
        return dst * src;
    }

    /**
     * evalIOR(dst, src)
     *
     * Adapted from /modules/pdp10/lib/cpuops.js:PDP10.IOR().
     *
     * Performs the logical "inclusive-or" (OR) of two operands > 32 bits.
     *
     * @this {DbgIO}
     * @param {number} dst
     * @param {number} src
     * @return {number} (dst | src)
     */
    evalIOR(dst, src)
    {
        /*
         * We OR the low 32 bits separately from the higher bits, and then combine them with addition.
         * Since all bits above 32 will be zero, and since 0 OR 0 is 0, no special masking for the higher
         * bits is required.
         *
         * WARNING: When using JavaScript's 32-bit operators with values that could set bit 31 and produce a
         * negative value, it's critical to perform a final right-shift of 0, ensuring that the final result is
         * positive.
         */
        if (this.nDefaultBits <= 32) {
            return dst | src;
        }
        /*
         * Negative values don't yield correct results when dividing, so pass them through an unsigned truncate().
         */
        dst = this.truncate(dst, 0, true);
        src = this.truncate(src, 0, true);
        return ((((dst / NumIO.TWO_POW32)|0) | ((src / NumIO.TWO_POW32)|0)) * NumIO.TWO_POW32) + ((dst | src) >>> 0);
    }

    /**
     * evalXOR(dst, src)
     *
     * Adapted from /modules/pdp10/lib/cpuops.js:PDP10.XOR().
     *
     * Performs the logical "exclusive-or" (XOR) of two operands > 32 bits.
     *
     * @this {DbgIO}
     * @param {number} dst
     * @param {number} src
     * @return {number} (dst ^ src)
     */
    evalXOR(dst, src)
    {
        /*
         * We XOR the low 32 bits separately from the higher bits, and then combine them with addition.
         * Since all bits above 32 will be zero, and since 0 XOR 0 is 0, no special masking for the higher
         * bits is required.
         *
         * WARNING: When using JavaScript's 32-bit operators with values that could set bit 31 and produce a
         * negative value, it's critical to perform a final right-shift of 0, ensuring that the final result is
         * positive.
         */
        if (this.nDefaultBits <= 32) {
            return dst ^ src;
        }
        /*
         * Negative values don't yield correct results when dividing, so pass them through an unsigned truncate().
         */
        dst = this.truncate(dst, 0, true);
        src = this.truncate(src, 0, true);
        return ((((dst / NumIO.TWO_POW32)|0) ^ ((src / NumIO.TWO_POW32)|0)) * NumIO.TWO_POW32) + ((dst ^ src) >>> 0);
    }

    /**
     * evalOps(aVals, aOps, cOps)
     *
     * Some of our clients want a specific number of bits of integer precision.  If that precision is
     * greater than 32, some of the operations below will fail; for example, JavaScript bitwise operators
     * always truncate the result to 32 bits, so beware when using shift operations.  Similarly, it would
     * be wrong to always "|0" the final result, which is why we rely on truncate() now.
     *
     * Note that JavaScript integer precision is limited to 52 bits.  For example, in Node, if you set a
     * variable to 0x80000001:
     *
     *      foo=0x80000001|0
     *
     * then calculate foo*foo and display the result in binary using "(foo*foo).toString(2)":
     *
     *      '11111111111111111111111111111100000000000000000000000000000000'
     *
     * which is slightly incorrect because it has overflowed JavaScript's floating-point precision.
     *
     * 0x80000001 in decimal is -2147483647, so the product is 4611686014132420609, which is 0x3FFFFFFF00000001.
     *
     * @this {DbgIO}
     * @param {Array.<number>} aVals
     * @param {Array.<string>} aOps
     * @param {number} [cOps] (default is -1 for all)
     * @return {boolean} true if successful, false if error
     */
    evalOps(aVals, aOps, cOps = -1)
    {
        while (cOps-- && aOps.length) {
            let chOp = aOps.pop();
            if (aVals.length < 2) return false;
            let valNew;
            let val2 = aVals.pop();
            let val1 = aVals.pop();
            switch(chOp) {
            case '*':
                valNew = this.evalMUL(val1, val2);
                break;
            case '/':
                if (!val2) return false;
                valNew = Math.trunc(val1 / val2);
                break;
            case '^/':
                if (!val2) return false;
                valNew = val1 % val2;
                break;
            case '+':
                valNew = val1 + val2;
                break;
            case '-':
                valNew = val1 - val2;
                break;
            case '<<':
                valNew = val1 << val2;
                break;
            case '>>':
                valNew = val1 >> val2;
                break;
            case '>>>':
                valNew = val1 >>> val2;
                break;
            case '<':
                valNew = (val1 < val2? 1 : 0);
                break;
            case '<=':
                valNew = (val1 <= val2? 1 : 0);
                break;
            case '>':
                valNew = (val1 > val2? 1 : 0);
                break;
            case '>=':
                valNew = (val1 >= val2? 1 : 0);
                break;
            case '==':
                valNew = (val1 == val2? 1 : 0);
                break;
            case '!=':
                valNew = (val1 != val2? 1 : 0);
                break;
            case '&':
                valNew = this.evalAND(val1, val2);
                break;
            case '!':           // alias for MACRO-10 to perform a bitwise inclusive-or (OR)
            case '|':
                valNew = this.evalIOR(val1, val2);
                break;
            case '^!':          // since MACRO-10 uses '^' for base overrides, '^!' is used for bitwise exclusive-or (XOR)
                valNew = this.evalXOR(val1, val2);
                break;
            case '&&':
                valNew = (val1 && val2? 1 : 0);
                break;
            case '||':
                valNew = (val1 || val2? 1 : 0);
                break;
            case ',,':
                valNew = this.truncate(val1, 18, true) * Math.pow(2, 18) + this.truncate(val2, 18, true);
                break;
            case '_':
            case '^_':
                valNew = val1;
                /*
                 * While we always try to avoid assuming any particular number of bits of precision, the 'B' shift
                 * operator (which we've converted to '^_') is unique to the MACRO-10 environment, which imposes the
                 * following restrictions on the shift count.
                 */
                if (chOp == '^_') val2 = 35 - (val2 & 0xff);
                if (val2) {
                    /*
                     * Since binary shifting is a logical (not arithmetic) operation, and since shifting by division only
                     * works properly with positive numbers, we call truncate() to produce an unsigned value.
                     */
                    valNew = this.truncate(valNew, 0, true);
                    if (val2 > 0) {
                        valNew *= Math.pow(2, val2);
                    } else {
                        valNew = Math.trunc(valNew / Math.pow(2, -val2));
                    }
                }
                break;
            default:
                return false;
            }
            aVals.push(this.truncate(valNew));
        }
        return true;
    }

    /**
     * parseArray(asValues, iValue, iLimit, nBase, aUndefined)
     *
     * parseExpression() takes a complete expression and divides it into array elements, where even elements
     * are values (which may be empty if two or more operators appear consecutively) and odd elements are operators.
     *
     * For example, if the original expression was "2*{3+{4/2}}", parseExpression() would call parseArray() with:
     *
     *      0   1   2   3   4   5   6   7   8   9  10  11  12  13  14
     *      -   -   -   -   -   -   -   -   -   -  --  --  --  --  --
     *      2   *       {   3   +       {   4   /   2   }       }
     *
     * This function takes care of recursively processing grouped expressions, by processing subsets of the array,
     * as well as handling certain base overrides (eg, temporarily switching to base-10 for binary shift suffixes).
     *
     * @this {DbgIO}
     * @param {Array.<string>} asValues
     * @param {number} iValue
     * @param {number} iLimit
     * @param {number} nBase
     * @param {Array|undefined} [aUndefined]
     * @return {number|undefined}
     */
    parseArray(asValues, iValue, iLimit, nBase, aUndefined)
    {
        let value;
        let sValue, sOp;
        let fError = false;
        let nUnary = 0;
        let aVals = [], aOps = [];

        let nBasePrev = this.nDefaultBase;
        this.nDefaultBase = nBase;

        while (iValue < iLimit) {
            let v;
            sValue = asValues[iValue++].trim();
            sOp = (iValue < iLimit? asValues[iValue++] : "");

            if (sValue) {
                v = this.parseValue(sValue, undefined, aUndefined, nUnary);
            } else {
                if (sOp == '{') {
                    let cOpen = 1;
                    let iStart = iValue;
                    while (iValue < iLimit) {
                        sValue = asValues[iValue++].trim();
                        sOp = (iValue < asValues.length? asValues[iValue++] : "");
                        if (sOp == '{') {
                            cOpen++;
                        } else if (sOp == '}') {
                            if (!--cOpen) break;
                        }
                    }
                    v = this.parseArray(asValues, iStart, iValue-1, this.nDefaultBase, aUndefined);
                    if (v != null && nUnary) {
                        v = this.parseUnary(v, nUnary);
                    }
                    sValue = (iValue < iLimit? asValues[iValue++].trim() : "");
                    sOp = (iValue < iLimit? asValues[iValue++] : "");
                }
                else {
                    /*
                     * When parseExpression() calls us, it has collapsed all runs of whitespace into single spaces,
                     * and although it allows single spaces to divide the elements of the expression, a space is neither
                     * a unary nor binary operator.  It's essentially a no-op.  If we encounter it here, then it followed
                     * another operator and is easily ignored (although perhaps it should still trigger a reset of nBase
                     * and nUnary -- TBD).
                     */
                    if (sOp == ' ') {
                        continue;
                    }
                    if (sOp == '^B') {
                        this.nDefaultBase = 2;
                        continue;
                    }
                    if (sOp == '^O') {
                        this.nDefaultBase = 8;
                        continue;
                    }
                    if (sOp == '^D') {
                        this.nDefaultBase = 10;
                        continue;
                    }
                    if (!(nUnary & (0xC0000000|0))) {
                        if (sOp == '+') {
                            continue;
                        }
                        if (sOp == '-') {
                            nUnary = (nUnary << 2) | 1;
                            continue;
                        }
                        if (sOp == '~' || sOp == '^-') {
                            nUnary = (nUnary << 2) | 2;
                            continue;
                        }
                        if (sOp == '^L') {
                            nUnary = (nUnary << 2) | 3;
                            continue;
                        }
                    }
                    fError = true;
                    break;
                }
            }

            if (v === undefined) {
                if (aUndefined) {
                    aUndefined.push(sValue);
                    v = 0;
                } else {
                    fError = true;
                    aUndefined = [];
                    break;
                }
            }

            aVals.push(this.truncate(v));

            /*
             * When parseExpression() calls us, it has collapsed all runs of whitespace into single spaces,
             * and although it allows single spaces to divide the elements of the expression, a space is neither
             * a unary nor binary operator.  It's essentially a no-op.  If we encounter it here, then it followed
             * a value, and since we don't want to misinterpret the next operator as a unary operator, we look
             * ahead and grab the next operator if it's not preceded by a value.
             */
            if (sOp == ' ') {
                if (iValue < asValues.length - 1 && !asValues[iValue]) {
                    iValue++;
                    sOp = asValues[iValue++]
                } else {
                    fError = true;
                    break;
                }
            }

            if (!sOp) break;

            let aBinOp = (this.achGroup[0] == '<'? DbgIO.DECOP_PRECEDENCE : DbgIO.BINOP_PRECEDENCE);
            if (!aBinOp[sOp]) {
                fError = true;
                break;
            }
            if (aOps.length && aBinOp[sOp] <= aBinOp[aOps[aOps.length - 1]]) {
                this.evalOps(aVals, aOps, 1);
            }
            aOps.push(sOp);

            /*
             * The MACRO-10 binary shifting operator assumes a base-10 shift count, regardless of the current
             * base, so we must override the current base to ensure the count is parsed correctly.
             */
            this.nDefaultBase = (sOp == '^_')? 10 : nBase;
            nUnary = 0;
        }

        if (fError || !this.evalOps(aVals, aOps) || aVals.length != 1) {
            fError = true;
        }

        if (!fError) {
            value = aVals.pop();
            this.assert(!aVals.length);
        } else if (!aUndefined) {
            this.println("parse error (" + (sValue || sOp) + ")");
        }

        this.nDefaultBase = nBasePrev;
        return value;
    }

    /**
     * parseASCII(sExpr, chDelim, nBits, cchMax)
     *
     * @this {DbgIO}
     * @param {string} sExpr
     * @param {string} chDelim
     * @param {number} nBits
     * @param {number} cchMax
     * @return {string|undefined}
     */
    parseASCII(sExpr, chDelim, nBits, cchMax)
    {
        let i;
        while ((i = sExpr.indexOf(chDelim)) >= 0) {
            let v = 0;
            let j = i + 1;
            let cch = cchMax;
            while (j < sExpr.length) {
                let ch = sExpr[j++];
                if (ch == chDelim) {
                    cch = -1;
                    break;
                }
                if (!cch) break;
                cch--;
                let c = ch.charCodeAt(0);
                if (nBits == 7) {
                    c &= 0x7F;
                } else {
                    c = (c - 0x20) & 0x3F;
                }
                v = this.truncate(v * Math.pow(2, nBits) + c, nBits * cchMax, true);
            }
            if (cch >= 0) {
                this.println("parse error (" + chDelim + sExpr + chDelim + ")");
                return undefined;
            } else {
                sExpr = sExpr.substr(0, i) + this.toBase(v) + sExpr.substr(j);
            }
        }
        return sExpr;
    }

    /**
     * parseExpression(sExpr, aUndefined)
     *
     * A quick-and-dirty expression parser.  It takes an expression like:
     *
     *      EDX+EDX*4+12345678
     *
     * and builds a value stack in aVals and a "binop" (binary operator) stack in aOps:
     *
     *      aVals       aOps
     *      -----       ----
     *      EDX         +
     *      EDX         *
     *      4           +
     *      ...
     *
     * We pop 1 "binop" from aOps and 2 values from aVals whenever a "binop" of lower priority than its
     * predecessor is encountered, evaluate, and push the result back onto aVals.  Only selected unary
     * operators are supported (eg, negate and complement); no ternary operators like '?:' are supported.
     *
     * aUndefined can be used to pass an array that collects any undefined variables that parseExpression()
     * encounters; the value of an undefined variable is zero.  This mode was added for components that need
     * to support expressions containing "fixups" (ie, values that must be determined later).
     *
     * @this {DbgIO}
     * @param {string|undefined} sExpr
     * @param {Array} [aUndefined] (collects any undefined variables)
     * @return {number|undefined} numeric value, or undefined if sExpr contains any undefined or invalid values
     */
    parseExpression(sExpr, aUndefined)
    {
        let value = undefined;

        if (sExpr) {
            /*
             * The default delimiting characters for grouped expressions are braces; they can be changed by altering
             * achGroup, but when that happens, instead of changing our regular expressions and operator tables,
             * we simply replace all achGroup characters with braces in the given expression.
             *
             * Why not use parentheses for grouped expressions?  Because some debuggers use parseReference() to perform
             * parenthetical value replacements in message strings, and they don't want parentheses taking on a different
             * meaning.  And for some machines, like the PDP-10, the convention is to use parentheses for other things,
             * like indexed addressing, and to use angle brackets for grouped expressions.
             */
            if (this.achGroup[0] != '{') {
                sExpr = sExpr.split(this.achGroup[0]).join('{').split(this.achGroup[1]).join('}');
            }

            /*
             * Quoted ASCII characters can have a numeric value, too, which must be converted now, to avoid any
             * conflicts with the operators below.
             */
            sExpr = this.parseASCII(sExpr, '"', 7, 5);  // MACRO-10 packs up to 5 7-bit ASCII codes into a value
            if (!sExpr) return value;
            sExpr = this.parseASCII(sExpr, "'", 6, 6);  // MACRO-10 packs up to 6 6-bit ASCII (SIXBIT) codes into a value
            if (!sExpr) return value;

            /*
             * All browsers (including, I believe, IE9 and up) support the following idiosyncrasy of a RegExp split():
             * when the RegExp uses a capturing pattern, the resulting array will include entries for all the pattern
             * matches along with the non-matches.  This effectively means that, in the set of expressions that we
             * support, all even entries in asValues will contain "values" and all odd entries will contain "operators".
             *
             * Although I started listing the operators in the RegExp in "precedential" order, that's not important;
             * what IS important is listing operators that contain shorter operators first.  For example, bitwise
             * shift operators must be listed BEFORE the logical less-than or greater-than operators.  The aBinOp tables
             * (BINOP_PRECEDENCE and DECOP_PRECEDENCE) are what determine precedence, not the RegExp.
             *
             * Also, to better accommodate MACRO-10 syntax, I've replaced the single '^' for XOR with '^!', and I've
             * added '!' as an alias for '|' (bitwise inclusive-or), '^-' as an alias for '~' (one's complement operator),
             * and '_' as a shift operator (+/- values specify a left/right shift, and the count is not limited to 32).
             *
             * And to avoid conflicts with MACRO-10 syntax, I've replaced the original mod operator ('%') with '^/'.
             *
             * The MACRO-10 binary shifting suffix ('B') is a bit more problematic, since a capital B can also appear
             * inside symbols, or inside hex values.  So if the default base is NOT 16, then I pre-scan for that suffix
             * and replace all non-symbolic occurrences with an internal shift operator ('^_').
             *
             * Note that parseInt(), which parseValue() relies on, supports both the MACRO-10 base prefix overrides
             * and the binary shifting suffix ('B'), but since that suffix can also be a bracketed expression, we have to
             * support it here as well.
             *
             * MACRO-10 supports only a subset of all the PCjs operators; for example, MACRO-10 doesn't support any of
             * the boolean logical/compare operators.  But unless we run into conflicts, I prefer sticking with this
             * common set of operators.
             *
             * All whitespace in the expression is collapsed to single spaces, and space has been added to the list
             * of "operators", but its sole function is as a separator, not as an operator.  parseArray() will ignore
             * single spaces as long as they are preceded and/or followed by a "real" operator.  It would be dangerous
             * to remove spaces entirely, because if an operator-less expression like "A B" was passed in, we would want
             * that to generate an error; if we converted it to "AB", evaluation might inadvertently succeed.
             */
            let regExp = /({|}|\|\||&&|\||\^!|\^B|\^O|\^D|\^L|\^-|~|\^_|_|&|!=|!|==|>=|>>>|>>|>|<=|<<|<|-|\+|\^\/|\/|\*|,,| )/;
            if (this.nDefaultBase != 16) {
                sExpr = sExpr.replace(/(^|[^A-Z0-9$%.])([0-9]+)B/, "$1$2^_").replace(/\s+/g, ' ');
            }
            let asValues = sExpr.split(regExp);
            value = this.parseArray(asValues, 0, asValues.length, this.nDefaultBase, aUndefined);
        }
        return value;
    }

    /**
     * parseUnary(value, nUnary)
     *
     * nUnary is actually a small "stack" of unary operations encoded in successive pairs of bits.
     * As parseExpression() encounters each unary operator, nUnary is shifted left 2 bits, and the
     * new unary operator is encoded in bits 0 and 1 (0b00 is none, 0b01 is negate, 0b10 is complement,
     * and 0b11 is reserved).  Here, we process the bits in reverse order (hence the stack-like nature),
     * ensuring that we process the unary operators associated with this value right-to-left.
     *
     * Since bitwise operators see only 32 bits, more than 16 unary operators cannot be supported
     * using this method.  We'll let parseExpression() worry about that; if it ever happens in practice,
     * then we'll have to switch to a more "expensive" approach (eg, an actual array of unary operators).
     *
     * @this {DbgIO}
     * @param {number} value
     * @param {number} nUnary
     * @return {number}
     */
    parseUnary(value, nUnary)
    {
        while (nUnary) {
            let bit;
            switch(nUnary & 0o3) {
            case 1:
                value = -this.truncate(value);
                break;
            case 2:
                value = this.evalXOR(value, -1);        // this is easier than adding an evalNOT()...
                break;
            case 3:
                bit = 35;                               // simple left-to-right zero-bit-counting loop...
                while (bit >= 0 && !this.evalAND(value, Math.pow(2, bit))) bit--;
                value = 35 - bit;
                break;
            }
            nUnary >>>= 2;
        }
        return value;
    }

    /**
     * parseValue(sValue, sName, aUndefined, nUnary)
     *
     * @this {DbgIO}
     * @param {string} [sValue]
     * @param {string} [sName] is the name of the value, if any
     * @param {Array} [aUndefined]
     * @param {number} [nUnary] (0 for none, 1 for negate, 2 for complement, 3 for leading zeros)
     * @return {number|undefined} numeric value, or undefined if sValue is either undefined or invalid
     */
    parseValue(sValue, sName, aUndefined, nUnary = 0)
    {
        let value;
        if (sValue != undefined) {
            value = this.getRegister(sValue.toUpperCase());
            if (value == undefined) {
                value = this.getVariable(sValue);
                if (value != undefined) {
                    let sUndefined = this.getVariableFixup(sValue);
                    if (sUndefined) {
                        if (aUndefined) {
                            aUndefined.push(sUndefined);
                        } else {
                            let valueUndefined = this.parseExpression(sUndefined, aUndefined);
                            if (valueUndefined !== undefined) {
                                value += valueUndefined;
                            } else {
                                if (MAXDEBUG) this.println("undefined " + (sName || "value") + ": " + sValue + " (" + sUndefined + ")");
                                value = undefined;
                            }
                        }
                    }
                } else {
                    /*
                    * A feature of MACRO-10 is that any single-digit number is automatically interpreted as base-10.
                    */
                    value = this.parseInt(sValue, sValue.length > 1 || this.nDefaultBase > 10? this.nDefaultBase : 10);
                }
            }
            if (value != undefined) {
                value = this.truncate(this.parseUnary(value, nUnary));
            } else {
                if (MAXDEBUG) this.println("invalid " + (sName || "value") + ": " + sValue);
            }
        } else {
            if (MAXDEBUG) this.println("missing " + (sName || "value"));
        }
        return value;
    }

    /**
     * truncate(v, nBits, fUnsigned)
     *
     * @this {DbgIO}
     * @param {number} v
     * @param {number} [nBits]
     * @param {boolean} [fUnsigned]
     * @return {number}
     */
    truncate(v, nBits, fUnsigned)
    {
        let limit, vNew = v;
        nBits = nBits || this.nDefaultBits;

        if (fUnsigned) {
            if (nBits == 32) {
                vNew = v >>> 0;
            }
            else if (nBits < 32) {
                vNew = v & ((1 << nBits) - 1);
            }
            else {
                limit = Math.pow(2, nBits);
                if (v < 0 || v >= limit) {
                    vNew = v % limit;
                    if (vNew < 0) vNew += limit;
                }
            }
        }
        else {
            if (nBits <= 32) {
                vNew = (v << (32 - nBits)) >> (32 - nBits);
            }
            else {
                limit = Math.pow(2, nBits - 1);
                if (v >= limit) {
                    vNew = (v % limit);
                    if (((v / limit)|0) & 1) vNew -= limit;
                } else if (v < -limit) {
                    vNew = (v % limit);
                    if ((((-v - 1) / limit) | 0) & 1) {
                        if (vNew) vNew += limit;
                    }
                    else {
                        if (!vNew) vNew -= limit;
                    }
                }
            }
        }
        if (v != vNew) {
            if (MAXDEBUG) this.println("warning: value " + v + " truncated to " + vNew);
            v = vNew;
        }
        return v;
    }

    /**
     * addBreak(aBreakAddr, address)
     *
     * @param {Array} aBreakAddr
     * @param {Address} address
     * @return {number} (>= 0 if added, < 0 if not)
     */
    addBreak(aBreakAddr, address)
    {
        let i = aBreakAddr.indexOf(address.off);
        if (i < 0) i = aBreakAddr.indexOf((address.off >>> 0) + NumIO.TWO_POW32);
        if (i >= 0) {
            i = -(i + 1);
        } else {
            for (i = 0; i < aBreakAddr.length; i++) {
                if (aBreakAddr[i] == undefined) break;
            }
            aBreakAddr[i] = address.off;
        }
        return i;
    }

    /**
     * clearBreak(index)
     *
     * @this {DbgIO}
     * @param {number} index
     * @return {string}
     */
    clearBreak(index)
    {
        if (index < -1) {
            return this.enumBreak(this.clearBreak.bind(this));
        }
        let i = index, result = "";
        let aBreakAddr = this.aBreakReadAddr;
        if (i >= aBreakAddr.length) {
            i -= aBreakAddr.length;
            aBreakAddr = this.aBreadWriteAddr;
        }
        if (i >= 0) {
            let addr = aBreakAddr[i];
            let isEmpty = function(aBreakAddr) {
                for (let i = 0; i < aBreakAddr.length; i++) {
                    if (aBreakAddr[i] != undefined) return false;
                }
                return true;
            };
            if (addr != undefined) {
                if (aBreakAddr == this.aBreakReadAddr) {
                    if (this.busMemory.untrapRead(addr, this.readBusCheck)) {
                        this.aBreakReadAddr[i] = undefined;
                        result += this.sprintf("%2d: br %#0x cleared\n", index, addr);
                    }
                } else {
                    if (this.busMemory.untrapWrite(addr, this.writeBusCheck)) {
                        this.aBreadWriteAddr[i] = undefined;
                        result += this.sprintf("%2d: bw %#0x cleared\n", index, addr);
                        if (isEmpty(this.aBreadWriteAddr)) {
                            this.aBreadWriteAddr = [];
                            if (isEmpty(this.aBreakReadAddr)) {
                                this.aBreakReadAddr = [];
                            }
                        }
                    }
                }
                if (!result) result = this.sprintf("invalid break address: %#0x\n", addr);
            }
            if (!result) result = this.sprintf("invalid break index: %d\n", index);
        }
        if (!result) result = "missing break index";
        return result;
    }

    /**
     * enableBreak(index, enable)
     *
     * @this {DbgIO}
     * @param {number} index
     * @param {boolean} [enable]
     * @return {string}
     */
    enableBreak(index, enable = false)
    {
        if (index < -1) {
            return this.enumBreak(this.enableBreak.bind(this), enable);
        }
        let result = "";
        if (index >= 0) {
            let i = index, cmd = "br";
            let aBreakAddr = this.aBreakReadAddr;
            if (i >= aBreakAddr.length) {
                i -= aBreakAddr.length;
                cmd = "bw";
                aBreakAddr = this.aBreadWriteAddr;
            }
            if (i >= 0) {
                let success = true;
                let addr = aBreakAddr[i], addrPrint;
                let action = enable? "enabled" : "disabled";
                if (addr < NumIO.TWO_POW32) {
                    addrPrint = addr;
                    if (enable) {
                        success = false;
                    } else {
                        addr = (addr >>> 0) + NumIO.TWO_POW32;
                    }
                } else {
                    addrPrint = (addr - NumIO.TWO_POW32)|0;
                    if (!enable) {
                        success = false;
                    } else {
                        addr = addrPrint;
                    }
                }
                if (!success) {
                    result += this.sprintf("%2d: %s %#0x already %s\n", index, cmd, addrPrint, action);
                } else {
                    aBreakAddr[i] = addr;
                    result += this.sprintf("%2d: %s %#0x %s\n", index, cmd, addrPrint, action);
                }
            }
        }
        if (!result) result = "missing break index";
        return result;
    }

    /**
     * enumBreak(func, option)
     *
     * @param {function(number,(boolean|undefined))} func
     * @param {boolean} [option]
     * @return {string}
     */
    enumBreak(func, option)
    {
        let result = "";
        let enumBreakAddr = function(aBreakAddrs, index = 0) {
            for (let i = 0; i < aBreakAddrs.length; i++) {
                let addr = aBreakAddrs[i];
                if (addr != undefined) result += func(index + i, option);
            }
        };
        enumBreakAddr(this.aBreakReadAddr);
        enumBreakAddr(this.aBreadWriteAddr, this.aBreakReadAddr.length);
        return result;
    }

    /**
     * listBreak(index)
     *
     * @this {DbgIO}
     * @param {number} [index]
     * @return {string}
     */
    listBreak(index)
    {
        let dbg = this;
        let result = "";
        let listBreakAddr = function(aBreakAddrs, cmd, offset) {
            for (let i = 0; i < aBreakAddrs.length; i++) {
                let addr = aBreakAddrs[i];
                if (addr == undefined) continue;
                if (index < 0 || index == i + offset) {
                    let enabled = "enabled";
                    if (addr >= NumIO.TWO_POW32) {
                        enabled = "disabled";
                        addr = (addr - NumIO.TWO_POW32)|0;
                    }
                    result += dbg.sprintf("%2d: br %#0x %s\n", i + offset, addr, enabled);
                }
            }
        };
        listBreakAddr(this.aBreakReadAddr, "br", 0);
        listBreakAddr(this.aBreadWriteAddr, "bw", this.aBreakReadAddr.length);
        if (!result) result = "no break addresses found";
        return result;
    }

    /**
     * setBreak(address, write)
     *
     * @this {DbgIO}
     * @param {Address} [address]
     * @param {boolean} [write]
     * @return {string}
     */
    setBreak(address, write)
    {
        let result = "";
        if (address) {
            let cmd = write? "bw" : "br";
            let aBusAddr = write? this.aBreadWriteAddr : this.aBreakReadAddr;
            let i = this.addBreak(aBusAddr, address);
            if (i >= 0) {
                if (!write) {
                    this.busMemory.trapRead(address.off, this.readBusCheck);
                } else {
                    this.busMemory.trapWrite(address.off, this.writeBusCheck);
                }
                if (write) i += this.aBreakReadAddr.length;
                result += this.sprintf("%2d: %s %#0x set\n", i, cmd, address.off);
            } else {
                result += this.sprintf("%s %#0x already set\n", cmd, address.off);
            }
        } else {
            result = "missing break address";
        }
        return result;
    }

    /**
     * checkBusRead(addr, value)
     *
     * @this {DbgIO}
     * @param {number} addr
     * @param {number} value
     */
    checkBusRead(addr, value)
    {
        if (this.historyBuffer.length && addr == this.cpu.regPC) {
            this.historyBuffer[this.historyNext++] = addr;
            if (this.historyNext == this.historyBuffer.length) this.historyNext = 0;
        }
        if (this.aBreakReadAddr.indexOf(addr) >= 0) {
            this.stopCPU(this.sprintf("read break() at %#0x", addr));
        }
    }

    /**
     * checkBusWrite(addr, value)
     *
     * @this {DbgIO}
     * @param {number} addr
     * @param {number} value
     */
    checkBusWrite(addr, value)
    {
        if (this.aBreadWriteAddr.indexOf(addr) >= 0) {
            this.stopCPU(this.sprintf("write break(%#0x) at %#0x", value, addr));
        }
    }

    /**
     * stopCPU(message)
     *
     * @this {DbgIO}
     * @param {string} message
     */
    stopCPU(message)
    {
        if (this.fBreakException) {
            /*
             * We don't print the message in this case, because the CPU's exception handler already
             * does that; it has to be prepared for any kind of exception, not just those that we throw.
             */
            throw new Error(message);
        }
        this.println(message);
        this.time.stop();
    }

    /**
     * dumpMemory(address, bits, length, format)
     *
     * @param {Address} [address] (default is addressPrev; advanced by the length of the dump)
     * @param {number} [bits] (default size is the memory bus data width; e.g., 8 bits)
     * @param {number} [length] (default length of dump is 128 values)
     * @param {string} [format] (formatting options; only 'y' for binary output is currently supported)
     * @return {string}
     */
    dumpMemory(address, bits, length, format)
    {
        let result = "";
        if (!bits) bits = this.busMemory.dataWidth;
        let size = bits >> 3;
        if (!length) length = 128;
        let fASCII = false, cchBinary = 0;
        let cLines = ((length + 15) >> 4) || 1;
        let cbLine = (size == 4? 16 : this.nDefaultBase);
        if (format == 'y') {
            cbLine = size;
            cLines = length;
            cchBinary = size * 8;
        }
        if (!address) address = this.addressPrev;
        while (cLines-- && length > 0) {
            let data = 0, iByte = 0, i;
            let sData = "", sChars = "";
            let sAddress = this.displayAddress(address);
            for (i = cbLine; i > 0 && length > 0; i--) {
                let b = this.readAddress(address, 1);
                data |= (b << (iByte++ << 3));
                if (iByte == size) {
                    sData += this.toBase(data, 0, bits);
                    sData += (size == 1? (i == 9? '-' : ' ') : " ");
                    if (cchBinary) sChars += this.toBase(data, 2, bits);
                    data = iByte = 0;
                }
                if (!cchBinary) sChars += (b >= 32 && b < 127? String.fromCharCode(b) : (fASCII? '' : '.'));
                length--;
            }
            if (result) result += '\n';
            if (fASCII) {
                result += sChars;
            } else {
                result += sAddress + "  " + sData + " " + sChars;
            }
        }
        this.addressPrev = address;
        return result;
    }

    /**
     * dumpHistory(index)
     *
     * The index parameter is interpreted as the number of instructions to rewind; if you also
     * specify a length, then that limits the number of instructions to display from the index point.
     *
     * @this {DbgIO}
     * @param {number} index
     * @param {number} [length]
     * @return {string}
     */
    dumpHistory(index, length = 10)
    {
        let result = "";
        if (index < 0) index = length;
        let i = this.historyNext - index;
        if (i < 0) i += this.historyBuffer.length;
        let address, opcodes = [];
        while (i >= 0 && i < this.historyBuffer.length && length > 0) {
            let addr = this.historyBuffer[i++];
            if (i == this.historyBuffer.length) i = 0;
            if (addr == undefined) continue;
            if (!address) address = this.newAddress(addr);
            if (addr != address.off || opcodes.length == this.maxOpLength) {
                this.addAddress(address, -opcodes.length);
                result += this.unassemble(address, opcodes);
                length--;
            }
            address.off = addr;
            opcodes.push(this.readAddress(address));
        }
        return result || "no history";
    }

    /**
     * enableHistory(enable)
     *
     * History refers to instruction execution history, which means we want to trap every read where
     * the requested address equals regPC.  So if history is being enabled, we preallocate an array to
     * record every such physical address.
     *
     * The upside to this approach is that no special hooks are required inside the CPU, since we are
     * simply leveraging the Bus' ability to use different read handlers for all ROM and RAM blocks.  The
     * downside is that we're recording the address of *every* byte of every instruction, not just that
     * of the *first* byte; however, dumpHistory() can compensate for that, by skipping the same bytes
     * that unassemble() must read as well.
     *
     * @this {DbgIO}
     * @param {boolean|undefined} enable
     * @return {string}
     */
    enableHistory(enable)
    {
        let dbg = this;
        let cBlocks = 0;
        if (enable == undefined) {
            return "unrecognized option";
        }
        cBlocks += this.busMemory.enumBlocks(Memory.TYPE.ROM | Memory.TYPE.RAM, function(block) {
            for (let addr = block.addr, off = 0; off < block.size; addr++, off++) {
                if (enable) {
                    dbg.busMemory.trapRead(addr, dbg.readBusCheck);
                } else {
                    dbg.busMemory.untrapRead(addr, dbg.readBusCheck);
                }
            }
        });
        if (cBlocks) {
            this.historyNext = 0;
            if (enable) {
                this.historyBuffer = new Array(DbgIO.HISTORY_LIMIT);
            } else {
                this.historyBuffer = [];
            }
        }
        return this.sprintf("history %s for %d blocks\n", enable? "enabled" : "disabled", cBlocks);
    }

    /**
     * onCommand(aTokens)
     *
     * Processes basic debugger commands.
     *
     * @this {DbgIO}
     * @param {Array.<string>} aTokens ([0] contains the entire command line; [1] and up contain tokens from the command)
     * @return {string}
     */
    onCommand(aTokens)
    {
        let result = "", sExpr;
        let count = 0, values = [], opcodes;
        let cmd = aTokens[1], index, address, bits, length, enable;

        if (aTokens[2] == '*') {
            index = -2;
        } else {
            index = this.parseInt(aTokens[2]);
            if (index == undefined) index = -1;
            address = this.parseAddress(aTokens[2]);
        }
        length = 0;
        if (aTokens[3]) {
            length = this.parseInt(aTokens[3].substr(aTokens[3][0] == 'l'? 1 : 0)) || 8;
        }
        for (let i = 3; i < aTokens.length; i++) {
            values.push(this.parseInt(aTokens[i], 16));
        }

        switch(cmd[0]) {
        case 'b':
            if (cmd[1] == 'c') {
                result = this.clearBreak(index);
            } else if (cmd[1] == 'd') {
                result = this.enableBreak(index);
            } else if (cmd[1] == 'e') {
                result = this.enableBreak(index, true);
            } else if (cmd[1] == 'l') {
                result = this.listBreak(index);
            } else if (cmd[1] == 'r') {
                result = this.setBreak(address);
            } else if (cmd[1] == 'w') {
                result = this.setBreak(address, true);
            } else {
                result = "break commands:";
                DbgIO.BREAK_COMMANDS.forEach((cmd) => {result += '\n' + cmd;});
                break;
            }
            break;

        case 'd':
            if (cmd[1] == 'b' || !cmd[1]) {
                bits = 8;
            } else if (cmd[1] == 'w') {
                bits = 16;
            } else if (cmd[1] == 'd') {
                bits = 32;
            } else if (cmd[1] == 'h') {
                result = this.dumpHistory(index);
                break;
            } else {
                result = "dump commands:";
                DbgIO.DUMP_COMMANDS.forEach((cmd) => {result += '\n' + cmd;});
                break;
            }
            result = this.dumpMemory(address, bits, length, cmd[2]);
            break;

        case 'e':
            for (let i = 0; address != undefined && i < values.length; i++) {
                let prev = this.readAddress(address);
                if (prev == undefined) break;
                this.writeAddress(address, values[i]);
                result += this.sprintf("%#06x: %#06x changed to %#06x\n", address.off, prev, values[i]);
                this.addAddress(address, 1);
                count++;
            }
            result += this.sprintf("%d locations updated\n", count);
            break;

        case 'g':
            if (this.time.start()) {
                if (address != undefined) this.setBreak(address);
            } else {
                result = "already started";
            }
            break;

        case 'h':
            if (!this.time.stop()) result = "already stopped";
            break;

        case 'p':
            aTokens.shift();
            aTokens.shift();
            sExpr = aTokens.join(' ');
            this.printf("%s = %s\n", sExpr, this.toBase(this.parseExpression(sExpr)));
            break;

        case 'r':
            if (address != undefined) this.cpu.setRegister(cmd.substr(1), address.off);
            result += this.cpu.toString(cmd[1]);
            this.sCommandPrev = aTokens[0];
            break;

        case 's':
            enable = this.parseBoolean(aTokens[2]);
            if (cmd[1] == 'h') {
                result = this.enableHistory(enable);
            } else {
                result = "set commands:";
                DbgIO.SET_COMMANDS.forEach((cmd) => {result += '\n' + cmd;});
                break;
            }
            break;

        case 't':
            length = this.parseInt(aTokens[2], 10) || 1;
            this.time.onStep(length);
            this.sCommandPrev = aTokens[0];
            break;

        case 'u':
            if (!length) length = 8;
            if (!address) address = this.addressPrev;
            opcodes = [];
            while (length--) {
                while (opcodes.length < this.maxOpLength) {
                    opcodes.push(this.readAddress(address, 1));
                }
                this.addAddress(address, -opcodes.length);
                result += this.unassemble(address, opcodes);
            }
            this.addressPrev = address;
            this.sCommandPrev = aTokens[0];
            break;

        case '?':
            result = "debugger commands:";
            DbgIO.COMMANDS.forEach((cmd) => {result += '\n' + cmd;});
            break;

        default:
            result = undefined;
            break;
        }

        if (result == undefined && aTokens[0]) {
            result = "unrecognized command '" + aTokens[0] + "' (try '?')";
        }

        if (result) this.println(result.replace(/\s+$/, ""));
        return result;
    }

    /**
     * unassemble(address, opcodes)
     *
     * Returns a string representation of the selected instruction.
     *
     * @this {DbgIO}
     * @param {Address} address (advanced by the number of processed opcodes)
     * @param {Array.<number>} opcodes (each processed opcode is shifted out, reducing the size of the array)
     * @return {string}
     */
    unassemble(address, opcodes)
    {
        let dbg = this;
        let getNextByte = function() {
            let byte = opcodes.shift();
            dbg.addAddress(address, 1);
            return byte;
        };
        let sAddress = this.displayAddress(address);
        let opcode = getNextByte();
        let sOp = "???", sOperands = "";
        return this.sprintf("%s: %02x  %-8s%s\n", sAddress, opcode, sOp, sOperands);
    }
}

DbgIO.COMMANDS = [
    "b?\t\tbreak commands",
    "d?\t\tdump commands",
    "e [addr] ...\tedit memory",
    "g [addr]\trun (to addr)",
    "h\t\thalt",
    "r[a]\t\tdump (all) registers",
    "s?\t\tset commands",
    "t [n]\t\tstep (n instructions)",
    "u [addr] [n]\tunassemble (at addr)"
];

DbgIO.BREAK_COMMANDS = [
    "bc [n|*]\tclear break address",
    "bd [n|*]\tdisable break address",
    "be [n|*]\tenable break address",
    "bl [n]\t\tlist break addresses",
    "br [addr]\tbreak on read",
    "bw [addr]\tbreak on write"
];

DbgIO.DUMP_COMMANDS = [
    "db  [addr]\tdump bytes (8 bits)",
    "dw  [addr]\tdump words (16 bits)",
    "dd  [addr]\tdump dwords (32 bits)",
    "d*y [addr]\tdump values in binary"
];

DbgIO.SET_COMMANDS = [
    "sh [on|off]\tset instruction history"
];

DbgIO.ADDRESS = {
    PHYSICAL:   0x00,
    LINEAR:     0x01,           // if seg is not set, this indicates whether the address is physical (clear) or linear (set)
    PROTECTED:  0x02            // if seg is set, this indicates whether the address is real (clear) or protected (set)
};

/*
 * Predefined "virtual registers" that we expect the CPU to support.
 */
DbgIO.REGISTER = {
    PC:         "PC"            // the CPU's program counter
};

DbgIO.HISTORY_LIMIT = 100000;

/*
 * These are our operator precedence tables.  Operators toward the bottom (with higher values) have
 * higher precedence.  BINOP_PRECEDENCE was our original table; we had to add DECOP_PRECEDENCE because
 * the precedence of operators in DEC's MACRO-10 expressions differ.  Having separate tables also allows
 * us to remove operators that shouldn't be supported, but unless some operator creates a problem,
 * I prefer to keep as much commonality between the tables as possible.
 *
 * Missing from these tables are the (limited) set of unary operators we support (negate and complement),
 * since this is only a BINARY operator precedence, not a general-purpose precedence table.  Assume that
 * all unary operators take precedence over all binary operators.
 */
DbgIO.BINOP_PRECEDENCE = {
    '||':   5,      // logical OR
    '&&':   6,      // logical AND
    '!':    7,      // bitwise OR (conflicts with logical NOT, but we never supported that)
    '|':    7,      // bitwise OR
    '^!':   8,      // bitwise XOR (added by MACRO-10 sometime between the 1972 and 1978 versions)
    '&':    9,      // bitwise AND
    '!=':   10,     // inequality
    '==':   10,     // equality
    '>=':   11,     // greater than or equal to
    '>':    11,     // greater than
    '<=':   11,     // less than or equal to
    '<':    11,     // less than
    '>>>':  12,     // unsigned bitwise right shift
    '>>':   12,     // bitwise right shift
    '<<':   12,     // bitwise left shift
    '-':    13,     // subtraction
    '+':    13,     // addition
    '^/':   14,     // remainder
    '/':    14,     // division
    '*':    14,     // multiplication
    '_':    19,     // MACRO-10 shift operator
    '^_':   19,     // MACRO-10 internal shift operator (converted from 'B' suffix form that MACRO-10 uses)
    '{':    20,     // open grouped expression (converted from achGroup[0])
    '}':    20      // close grouped expression (converted from achGroup[1])
};

DbgIO.DECOP_PRECEDENCE = {
    ',,':   1,      // high-word,,low-word
    '||':   5,      // logical OR
    '&&':   6,      // logical AND
    '!=':   10,     // inequality
    '==':   10,     // equality
    '>=':   11,     // greater than or equal to
    '>':    11,     // greater than
    '<=':   11,     // less than or equal to
    '<':    11,     // less than
    '>>>':  12,     // unsigned bitwise right shift
    '>>':   12,     // bitwise right shift
    '<<':   12,     // bitwise left shift
    '-':    13,     // subtraction
    '+':    13,     // addition
    '^/':   14,     // remainder
    '/':    14,     // division
    '*':    14,     // multiplication
    '!':    15,     // bitwise OR (conflicts with logical NOT, but we never supported that)
    '|':    15,     // bitwise OR
    '^!':   15,     // bitwise XOR (added by MACRO-10 sometime between the 1972 and 1978 versions)
    '&':    15,     // bitwise AND
    '_':    19,     // MACRO-10 shift operator
    '^_':   19,     // MACRO-10 internal shift operator (converted from 'B' suffix form that MACRO-10 uses)
    '{':    20,     // open grouped expression (converted from achGroup[0])
    '}':    20      // close grouped expression (converted from achGroup[1])
};