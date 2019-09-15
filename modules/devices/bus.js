/**
 * @fileoverview Manages address spaces for machines
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
 * @typedef {Config} BusConfig
 * @property {number} addrWidth (default is 16)
 * @property {number} dataWidth (default is 8)
 * @property {number} [blockSize] (default is 1024)
 */

/**
 * @class {Bus}
 * @unrestricted
 * @property {BusConfig} config
 * @property {number} addrWidth
 * @property {number} dataWidth
 * @property {number} addrTotal
 * @property {number} addrLimit
 * @property {number} blockSize
 * @property {number} blockTotal
 * @property {number} blockShift
 * @property {number} blockLimit
 * @property {Array.<Memory>} blocks
 */
class Bus extends Device {
    /**
     * Bus(idMachine, idDevice, config)
     *
     * Sample config:
     *
     *      "bus": {
     *        "class": "Bus",
     *        "addrWidth": 16,
     *        "dataWidth": 8,
     *        "blockSize": 1024
     *      }
     *
     * @this {Bus}
     * @param {string} idMachine
     * @param {string} idDevice
     * @param {ROMConfig} [config]
     */
    constructor(idMachine, idDevice, config)
    {
        super(idMachine, idDevice, config);

        this.addrWidth = config['addrWidth'] || 16;
        this.dataWidth = config['dataWidth'] || 8;
        this.addrTotal = Math.pow(2, this.addrWidth);
        this.addrLimit = (this.addrTotal - 1)|0;
        this.blockSize = config['blockSize'] || 1024;
        this.blockTotal = (this.addrTotal / this.blockSize)|0;
        this.blockShift = Math.log2(this.blockSize)|0;
        this.blockLimit = (1 << this.blockShift) - 1;
        this.blocks = new Array(this.blockTotal);
        let memory = new Memory(idMachine, idDevice + ".none", {"addr": undefined, "size": this.blockSize});
        for (let addr = 0; addr < this.addrTotal; addr += this.blockSize) {
            this.addBlocks(addr, this.blockSize, Memory.TYPE.NONE, memory);
        }
    }

    /**
     * addBlocks(addr, size, type, block)
     *
     * Bus interface for other devices to add blocks at specific addresses.  It's an error to add blocks to
     * regions that already contain blocks (other than blocks with TYPE of NONE).  There is no attempt to clean
     * up that error (and there is no removeBlocks() function) because it's currently considered a configuration
     * error, but that will likely change as machines with fancier buses are added.
     *
     * @this {Bus}
     * @param {number} addr is the starting physical address of the request
     * @param {number} size of the request, in bytes
     * @param {number} type is one of the Memory.TYPE constants
     * @param {Memory} [block] (optional preallocated block that must implement the same Memory interfaces the Bus uses)
     * @return {boolean}
     */
    addBlocks(addr, size, type, block)
    {
        let addrNext = addr;
        let sizeLeft = size;
        let offset = 0, nBlocks = 0;
        let iBlock = addrNext >>> this.blockShift;
        while (sizeLeft > 0 && iBlock < this.blocks.length) {
            let blockNew;
            let addrBlock = iBlock * this.blockSize;
            let sizeBlock = this.blockSize - (addrNext - addrBlock);
            if (sizeBlock > sizeLeft) sizeBlock = sizeLeft;
            let blockExisting = this.blocks[iBlock];
            /*
             * Make sure that no block exists at the specified address, or if so, make sure its type is NONE.
             */
            if (blockExisting && blockExisting.type != Memory.TYPE.NONE) return false;
            /*
             * When no block is provided, we must allocate one that matches the specified type (and remaining size).
             */
            if (!block) {
                blockNew = new Memory(this.idMachine, this.idDevice + ".block" + nBlocks, {type, addr: addrNext, size: sizeBlock});
            } else {
                /*
                 * When a block is provided, make sure its size maches the default Bus block size, and use it if so.
                 */
                if (block['size'] == this.blockSize) {
                    blockNew = block;
                } else {
                    /*
                     * When a block of a different size is provided, make a new block, importing any values as needed.
                     */
                    let values;
                    if (block['values']) {
                        values = block['values'].slice(offset, offset + sizeBlock);
                    }
                    blockNew = new Memory(this.idMachine, block.idDevice + ".block" + nBlocks, {type, addr: addrNext, size: sizeBlock, values});
                }
            }
            this.blocks[iBlock++] = blockNew;
            addrNext = addrBlock + this.blockSize;
            sizeLeft -= sizeBlock;
            offset += sizeBlock;
            nBlocks++;
        }
        return true;
    }

    /**
     * cleanBlocks(addr, size)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {number} size
     * @return {boolean} true if all blocks were clean, false if dirty; all blocks are cleaned in the process
     */
    cleanBlocks(addr, size)
    {
        let clean = true;
        let iBlock = addr >>> this.blockShift;
        let sizeBlock = this.blockSize - (addr & this.blockLimit);
        while (size > 0 && iBlock < this.blocks.length) {
            if (this.blocks[iBlock].isDirty()) clean = false;
            size -= sizeBlock;
            sizeBlock = this.blockSize;
            iBlock++;
        }
        return clean;
    }

    /**
     * enumBlocks(type, func)
     *
     * This is used by the Debugger to enumerate all the blocks of a certain type.
     *
     * @this {Bus}
     * @param {number} type
     * @param {function(Memory)} func
     * @return {number} (the number of blocks enumerated)
     */
    enumBlocks(type, func)
    {
        let cBlocks = 0;
        for (let iBlock = 0; iBlock < this.blocks.length; iBlock++) {
            let block = this.blocks[iBlock];
            if (!block || !(block.type & type)) continue;
            func(block);
            cBlocks++;
        }
        return cBlocks;
    }

    /**
     * readData(addr, ref)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {number} [ref] (optional reference value, such as the CPU's program counter at the time of access)
     * @returns {number|undefined}
     */
    readData(addr, ref)
    {
        return this.blocks[(addr & this.addrLimit) >>> this.blockShift].readData(addr & this.blockLimit);
    }

    /**
     * writeData(addr, value, ref)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {number} value
     * @param {number} [ref] (optional reference value, such as the CPU's program counter at the time of access)
     */
    writeData(addr, value, ref)
    {
        this.blocks[(addr & this.addrLimit) >>> this.blockShift].writeData(addr & this.blockLimit, value);
    }

    /**
     * trapRead(addr, func)
     *
     * I've decided to call the trap handler AFTER reading the value, so that we can pass the value
     * along with the address; for example, the Debugger might find that useful for its history buffer.
     *
     * @this {Bus}
     * @param {number} addr
     * @param {function(number,number)} func (receives the address and the value read)
     * @return {boolean} true if trap successful, false if already trapped by another function
     */
    trapRead(addr, func)
    {
        let iBlock = addr >>> this.blockShift;
        let block = this.blocks[iBlock];
        let readTrap = function(offset) {
            let value = block.readPrev(offset);
            block.readTrap(block.addr + offset, value);
            return value;
        };
        if (!block.nReadTraps) {
            block.nReadTraps = 1;
            block.readTrap = func;
            block.readPrev = block.readData;
            block.readData = readTrap;
        } else if (block.readTrap == func) {
            block.nReadTraps++;
        } else {
            return false;
        }
        return true;
    }

    /**
     * trapWrite(addr, func)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {function(number, number)} func (receives the address and the value to write)
     * @return {boolean} true if trap successful, false if already trapped by another function
     */
    trapWrite(addr, func)
    {
        let iBlock = addr >>> this.blockShift;
        let block = this.blocks[iBlock];
        let writeTrap = function(offset, value) {
            block.writeTrap(block.addr + offset, value);
            block.writePrev(offset, value);
        };
        if (!block.nWriteTraps) {
            block.nWriteTraps = 1;
            block.writeTrap = func;
            block.writePrev = block.writeData;
            block.writeData = writeTrap;
        } else if (block.writeTrap == func) {
            block.nWriteTraps++;
        } else {
            return false;
        }
        return true;
    }

    /**
     * untrapRead(addr, func)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {function(number,number)} func
     * @return {boolean} true if untrap successful, false if no (or another) trap was in effect
     */
    untrapRead(addr, func)
    {
        let iBlock = addr >>> this.blockShift;
        let block = this.blocks[iBlock];
        if (block.nReadTraps && block.readTrap == func) {
            if (!--block.nReadTraps) {
                block.readData = block.readPrev;
                block.readPrev = block.readTrap = undefined;
            }
            return true;
        }
        return false;
    }

    /**
     * untrapWrite(addr, func)
     *
     * @this {Bus}
     * @param {number} addr
     * @param {function(number, number)} func
     * @return {boolean} true if untrap successful, false if no (or another) trap was in effect
     */
    untrapWrite(addr, func)
    {
        let iBlock = addr >>> this.blockShift;
        let block = this.blocks[iBlock];
        if (block.nWriteTraps && block.writeTrap == func) {
            if (!--block.nWriteTraps) {
                block.writeData = block.writePrev;
                block.writePrev = block.writeTrap = undefined;
            }
            return true;
        }
        return false;
    }
}