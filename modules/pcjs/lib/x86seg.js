/**
 * @fileoverview Implements PCjs X86 Segment Registers
 * @author <a href="mailto:Jeff@pcjs.org">Jeff Parsons</a>
 * @version 1.0
 * Created 2014-Sep-10
 *
 * Copyright © 2012-2015 Jeff Parsons <Jeff@pcjs.org>
 *
 * This file is part of PCjs, which is part of the JavaScript Machines Project (aka JSMachines)
 * at <http://jsmachines.net/> and <http://pcjs.org/>.
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
 * You are required to include the above copyright notice in every source code file of every
 * copy or modified version of this work, and to display that copyright notice on every screen
 * that loads or runs any version of this software (see Computer.sCopyright).
 *
 * Some PCjs files also attempt to load external resource files, such as character-image files,
 * ROM files, and disk image files. Those external resource files are not considered part of the
 * PCjs program for purposes of the GNU General Public License, and the author does not claim
 * any copyright as to their contents.
 */

"use strict";

if (typeof module !== 'undefined') {
    var str         = require("../../shared/lib/strlib");
    var Messages    = require("./messages");
    var Memory      = require("./memory");
    var X86         = require("./x86");
}

/**
 * @class X86Seg
 * @property {number} sel
 * @property {number} limit (in protected-mode, this comes from descriptor word 0x0)
 * @property {number} base (in protected-mode, this comes from descriptor word 0x2)
 * @property {number} acc (in protected-mode, this comes from descriptor word 0x4, masked with 0xff00; bits 0-7 supplement base bits 16-23)
 * @property {number} ext (in protected-mode, this is descriptor word 0x6, 80386 only; supplements limit bits 16-19 and base bits 24-31)
 *
 * TODO: Determine what good, if any, these class annotations are for either an IDE like WebStorm or a tool like
 * the Closure Compiler.  More importantly, what good do they do at runtime?  Is it better to simply ensure that all
 * object properties are explicitly initialized in the constructor, and document them there instead?
 */

/**
 * X86Seg(cpu, sName)
 *
 * @constructor
 * @param {X86CPU} cpu
 * @param {number} id
 * @param {string} [sName] segment register name
 * @param {boolean} [fProt] true if segment register used exclusively in protected-mode (eg, segLDT)
 */
function X86Seg(cpu, id, sName, fProt)
{
    this.cpu = cpu;
    this.dbg = cpu.dbg;
    this.id = id;
    this.sName = sName || "";
    this.sel = 0;
    this.limit = 0xffff;
    this.offMax = this.limit + 1;
    this.base = 0;
    this.acc = this.type = 0;
    this.ext = 0;
    this.cpl = this.dpl = 0;
    this.addrDesc = X86.ADDR_INVALID;
    this.dataSize = this.addrSize = 2;
    this.dataMask = this.addrMask = 0xffff;
    /*
     * The following properties are used for CODE segments only (ie, segCS); if the process of loading
     * CS also requires a stack switch, then fStackSwitch will be set to true; additionally, if the stack
     * switch was the result of a CALL (ie, fCall is true) and one or more (up to 32) parameters are on
     * the old stack, they will be copied to awParms, and then once the stack is switched, the parameters
     * will be pushed from awParms onto the new stack.
     *
     * The typical ways of loading a new segment into CS are JMPF, CALLF (or INT), and RETF (or IRET);
     * prior to calling segCS.load(), each of those operations must first set segCS.fCall to one of null,
     * true, or false, respectively.
     *
     * It's critical that fCall be properly set prior to calling segCS.load(); fCall === null means NO
     * privilege level transition may occur, fCall === true allows a stack switch and a privilege transition
     * to a numerically lower privilege, and fCall === false allows a stack restore and a privilege transition
     * to a numerically greater privilege.
     *
     * As long as setCSIP() or fnINT() are used for all CS changes, fCall is set automatically.
     *
     * TODO: Consider making fCall a parameter to load(), instead of a property that must be set prior to
     * calling load(); the downside is that such a parameter is meaningless for segments other than segCS.
     */
    this.awParms = (this.id == X86Seg.ID.CODE? new Array(32) : []);
    this.fCall = null;
    this.fStackSwitch = false;
    this.updateMode(true, fProt);
}

X86Seg.ID = {
    NULL:   0,          // "NULL"
    CODE:   1,          // "CS"
    DATA:   2,          // "DS", "ES", "FS", "GS"
    STACK:  3,          // "SS"
    TSS:    4,          // "TSS"
    LDT:    5,          // "LDT"
    OTHER:  6,          // "VER"
    DEBUG:  7           // "DBG"
};

/**
 * loadReal(sel, fSuppress)
 *
 * The default segment load() function for real-mode.
 *
 * @this {X86Seg}
 * @param {number} sel
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} base address of selected segment, or ADDR_INVALID if error (TODO: No error conditions yet)
 */
X86Seg.prototype.loadReal = function loadReal(sel, fSuppress)
{
    this.sel = sel & 0xffff;
    /*
     * Loading a new value into a segment register in real-mode alters ONLY the selector and the base;
     * all other attributes (eg, limit, operand size, address size, etc) are unchanged.  If you run any
     * code that switches to protected-mode, loads a 32-bit code segment, and then switches back to
     * real-mode, it is THAT code's responsibility to load a 16-bit segment into CS before returning to
     * real-mode; otherwise, your machine will probably be toast.
     */
    return this.base = this.sel << 4;
};

/**
 * loadProt(sel, fSuppress)
 *
 * This replaces the segment's default load() function whenever the segment is notified via updateMode() by the
 * CPU's setProtMode() that the processor is now in protected-mode.
 *
 * Segments in protected-mode are referenced by selectors, which are indexes into descriptor tables (GDT or LDT)
 * whose descriptors are 4-word (8-byte) entries:
 *
 *      word 0: segment limit (0-15)
 *      word 1: base address low
 *      word 2: base address high (0-7), segment type (8-11), descriptor type (12), DPL (13-14), present bit (15)
 *      word 3: used only on 80386 and up (should be set to zero for upward compatibility)
 *
 * See X86.DESC for offset and bit definitions.
 *
 * IDT descriptor entries are handled separately by loadIDT(), which is mapped to loadIDTReal() or loadIDTProt().
 *
 * @this {X86Seg}
 * @param {number} sel
 * @param {boolean} [fSuppress] is true to suppress any errors, cycle assessment, etc
 * @return {number} base address of selected segment, or ADDR_INVALID if error
 */
X86Seg.prototype.loadProt = function loadProt(sel, fSuppress)
{
    var addrDT;
    var addrDTLimit;
    var cpu = this.cpu;

    /*
     * Some instructions (eg, CALLF) load a 32-bit value for the selector, while others (eg, LDS) do not;
     * however, in ALL cases, only the low 16 bits are significant.
     */
    sel &= 0xffff;

    if (!(sel & X86.SEL.LDT)) {
        addrDT = cpu.addrGDT;
        addrDTLimit = cpu.addrGDTLimit;
    } else {
        addrDT = cpu.segLDT.base;
        addrDTLimit = (addrDT + cpu.segLDT.limit)|0;
    }
    /*
     * The ROM BIOS POST executes some test code in protected-mode without properly initializing the LDT,
     * which has no bearing on the ROM's own code, because it never loads any LDT selectors, but if at the same
     * time our Debugger attempts to validate a selector in one of its breakpoints, that could cause some
     * grief here.  We avoid that grief by 1) relying on the Debugger setting fSuppress to true, and 2) skipping
     * segment lookup if the descriptor table being referenced is zero.
     *
     * TODO: This could probably be simplified to a test of addrDT; however, there's nothing in the design
     * of the CPU that prevents the GDT or LDT being located at linear address zero.
     */
    if (!fSuppress || addrDT) {
        var addrDesc = (addrDT + (sel & X86.SEL.MASK))|0;
        if ((addrDTLimit - addrDesc)|0 >= 7) {
            /*
             * TODO: This is only the first of many steps toward accurately counting cycles in protected mode;
             * I simply noted that "POP segreg" takes 5 cycles in real mode and 20 in protected mode, so I'm
             * starting with a 15-cycle difference.  Obviously the difference will vary with the instruction,
             * and will be much greater whenever the load fails.
             */
            if (!fSuppress) cpu.nStepCycles -= 15;
            return this.loadDesc8(addrDesc, sel, fSuppress);
        }
        if (!fSuppress) {
            X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, sel);
        }
    }
    return X86.ADDR_INVALID;
};

/**
 * loadIDTReal(nIDT)
 *
 * @this {X86Seg}
 * @param {number} nIDT
 * @return {number} address from selected vector, or ADDR_INVALID if error (TODO: No error conditions yet)
 */
X86Seg.prototype.loadIDTReal = function loadIDTReal(nIDT)
{
    var cpu = this.cpu;
    /*
     * NOTE: The Compaq DeskPro 386 ROM loads the IDTR for the real-mode IDT with a limit of 0xffff instead
     * of the normal 0x3ff.  A limit higher than 0x3ff is OK, since all real-mode IDT entries are 4 bytes, and
     * there's no way to issue an interrupt with a vector > 0xff.  Just something to be aware of.
     */
    cpu.assert(nIDT >= 0 && nIDT < 256 && !cpu.addrIDT && cpu.addrIDTLimit >= 0x3ff);
    /*
     * Intel documentation for INT/INTO under "REAL ADDRESS MODE EXCEPTIONS" says:
     *
     *      "[T]he 80286 will shut down if the SP = 1, 3, or 5 before executing the INT or INTO instruction--due to lack of stack space"
     *
     * TODO: Verify that 80286 real-mode actually enforces the above.  See http://localhost:8088/pubs/pc/reference/intel/80286/progref/#page-260
     */
    var addrIDT = cpu.addrIDT + (nIDT << 2);
    var off = cpu.getShort(addrIDT);
    cpu.regPS &= ~(X86.PS.TF | X86.PS.IF);
    return (this.load(cpu.getShort(addrIDT + 2)) + off)|0;
};

/**
 * loadIDTProt(nIDT)
 *
 * @this {X86Seg}
 * @param {number} nIDT
 * @return {number} address from selected vector, or ADDR_INVALID if error (TODO: No error conditions yet)
 */
X86Seg.prototype.loadIDTProt = function loadIDTProt(nIDT)
{
    var cpu = this.cpu;
    cpu.assert(nIDT >= 0 && nIDT < 256);

    nIDT <<= 3;
    var addrDesc = (cpu.addrIDT + nIDT)|0;
    if (((cpu.addrIDTLimit - addrDesc)|0) >= 7) {
        return this.loadDesc8(addrDesc, nIDT) + cpu.regEIP;
    }
    X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, nIDT | X86.ERRCODE.IDT | X86.ERRCODE.EXT, true);
    return X86.ADDR_INVALID;
};

/**
 * checkReadReal(off, cb, fSuppress)
 *
 * TODO: Invoke X86.fnFault.call(this.cpu, X86.EXCEPTION.GP_FAULT) if off+cb is beyond offMax on 80186 and up;
 * also, determine whether fnFault() call should include an error code, since this is happening in real-mode.
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, or ADDR_INVALID if error (TODO: No error conditions yet)
 */
X86Seg.prototype.checkReadReal = function checkReadReal(off, cb, fSuppress)
{
    return (this.base + off)|0;
};

/**
 * checkWriteReal(off, cb, fSuppress)
 *
 * TODO: Invoke X86.fnFault.call(this.cpu, X86.EXCEPTION.GP_FAULT) if off+cb is beyond offMax on 80186 and up;
 * also, determine whether fnFault() call should include an error code, since this is happening in real-mode.
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, or ADDR_INVALID if error (TODO: No error conditions yet)
 */
X86Seg.prototype.checkWriteReal = function checkWriteReal(off, cb, fSuppress)
{
    return (this.base + off)|0;
};

/**
 * checkReadProt(off, cb, fSuppress)
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, or ADDR_INVALID if not
 */
X86Seg.prototype.checkReadProt = function checkReadProt(off, cb, fSuppress)
{
    /*
     * Since off could be a 32-bit value with the sign bit (bit 31) set, we must convert
     * it to an unsigned value using ">>>"; offMax was already converted at segment load time.
     */
    if ((off >>> 0) + cb <= this.offMax) {
        return (this.base + off)|0;
    }
    return this.checkReadProtDisallowed(off, cb, fSuppress);
};

/**
 * checkReadProtDown(off, cb, fSuppress)
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, ADDR_INVALID if not
 */
X86Seg.prototype.checkReadProtDown = function checkReadProtDown(off, cb, fSuppress)
{
    /*
     * Since off could be a 32-bit value with the sign bit (bit 31) set, we must convert
     * it to an unsigned value using ">>>"; offMax was already converted at segment load time.
     */
    if ((off >>> 0) + cb > this.offMax) {
        return (this.base + off)|0;
    }
    return this.checkReadProtDisallowed(off, cb, fSuppress);
};

/**
 * checkReadProtDisallowed(off, cb, fSuppress)
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, ADDR_INVALID if not
 */
X86Seg.prototype.checkReadProtDisallowed = function checkReadProtDisallowed(off, cb, fSuppress)
{
    if (!fSuppress) {
        X86.fnFault.call(this.cpu, X86.EXCEPTION.GP_FAULT, 0);
    }
    return X86.ADDR_INVALID;
};

/**
 * checkWriteProt(off, cb, fSuppress)
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, ADDR_INVALID if not
 */
X86Seg.prototype.checkWriteProt = function checkWriteProt(off, cb, fSuppress)
{
    /*
     * Since off could be a 32-bit value with the sign bit (bit 31) set, we must convert
     * it to an unsigned value using ">>>"; offMax was already converted at segment load time.
     */
    if ((off >>> 0) + cb <= this.offMax) {
        return (this.base + off)|0;
    }
    return this.checkWriteProtDisallowed(off, cb, fSuppress);
};

/**
 * checkWriteProtDown(off, cb, fSuppress)
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, ADDR_INVALID if not
 */
X86Seg.prototype.checkWriteProtDown = function checkWriteProtDown(off, cb, fSuppress)
{
    /*
     * Since off could be a 32-bit value with the sign bit (bit 31) set, we must convert
     * it to an unsigned value using ">>>"; offMax was already converted at segment load time.
     */
    if ((off >>> 0) + cb > this.offMax) {
        return (this.base + off)|0;
    }
    return this.checkWriteProtDisallowed(off, cb, fSuppress);
};

/**
 * checkWriteProtDisallowed(off, cb, fSuppress)
 *
 * @this {X86Seg}
 * @param {number} off is a segment-relative offset
 * @param {number} cb is number of bytes to check (1, 2 or 4)
 * @param {boolean} [fSuppress] is true to suppress any errors
 * @return {number} corresponding linear address if valid, ADDR_INVALID if not
 */
X86Seg.prototype.checkWriteProtDisallowed = function checkWriteProtDisallowed(off, cb, fSuppress)
{
    if (!fSuppress) {
        X86.fnFault.call(this.cpu, X86.EXCEPTION.GP_FAULT, 0);
    }
    return X86.ADDR_INVALID;
};

/**
 * switchTSS(selNew, fNest)
 *
 * Implements TSS (Task State Segment) task switching.
 *
 * NOTES: This typically occurs during double-fault processing, because the IDT entry for DF_FAULT normally
 * contains a task gate.  Interestingly, if we force a GP_FAULT to occur at a sufficiently early point in the
 * OS/2 1.0 initialization code, OS/2 does a nice job of displaying the GP fault and then shutting down:
 *
 *      0090:067B FB            STI
 *      0090:067C EBFD          JMP      067B
 *
 * but it may not have yet reprogrammed the master PIC to re-vector hardware interrupts to IDT entries 0x50-0x57,
 * so when the next timer interrupt (IRQ 0) occurs, it vectors through IDT entry 0x08, which is the DF_FAULT
 * vector. A spurious double-fault is generated, and a clean shutdown turns into a messy crash.
 *
 * Of course, that all could have been avoided if IBM had heeded Intel's advice and not used Intel-reserved IDT
 * entries for PC interrupts.
 *
 * TODO: Add 80386 TSS support (including CR3 support).
 *
 * @this {X86Seg}
 * @param {number} selNew
 * @param {boolean} fNest is true if nesting, false if un-nesting
 * @return {boolean} true if successful, false if error
 */
X86Seg.prototype.switchTSS = function switchTSS(selNew, fNest)
{
    var cpu = this.cpu;
    cpu.assert(this === cpu.segCS);

    var addrOld = cpu.segTSS.base;
    var cplOld = this.cpl;
    var selOld = cpu.segTSS.sel;
    if (!fNest) {
        if (cpu.segTSS.type != X86.DESC.ACC.TYPE.TSS_BUSY) {
            X86.fnFault.call(cpu, X86.EXCEPTION.TS_FAULT, selNew, true);
            return false;
        }
        cpu.setShort(cpu.segTSS.addrDesc + X86.DESC.ACC.OFFSET, (cpu.segTSS.acc & ~X86.DESC.ACC.TYPE.TSS_BUSY) | X86.DESC.ACC.TYPE.TSS);
    }
    if (cpu.segTSS.load(selNew) === X86.ADDR_INVALID) {
        return false;
    }
    var addrNew = cpu.segTSS.base;
    if (DEBUG && DEBUGGER && this.dbg && this.dbg.messageEnabled(Messages.TSS)) {
        this.dbg.message((fNest? "Task switch" : "Task return") + ": TR " + str.toHexWord(selOld) + " (%" + str.toHex(addrOld, 6) + "), new TR " + str.toHexWord(selNew) + " (%" + str.toHex(addrNew, 6) + ")");
    }
    if (fNest) {
        if (cpu.segTSS.type == X86.DESC.ACC.TYPE.TSS_BUSY) {
            X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, selNew, true);
            return false;
        }
        cpu.setShort(cpu.segTSS.addrDesc + X86.DESC.ACC.OFFSET, cpu.segTSS.acc |= X86.DESC.ACC.TYPE.TSS_BUSY);
        cpu.segTSS.type = X86.DESC.ACC.TYPE.TSS_BUSY;
    }
    cpu.setShort(addrOld + X86.TSS.TASK_IP, cpu.getIP());
    cpu.setShort(addrOld + X86.TSS.TASK_PS, cpu.getPS());
    cpu.setShort(addrOld + X86.TSS.TASK_AX, cpu.regEAX);
    cpu.setShort(addrOld + X86.TSS.TASK_CX, cpu.regECX);
    cpu.setShort(addrOld + X86.TSS.TASK_DX, cpu.regEDX);
    cpu.setShort(addrOld + X86.TSS.TASK_BX, cpu.regEBX);
    cpu.setShort(addrOld + X86.TSS.TASK_SP, cpu.getSP());
    cpu.setShort(addrOld + X86.TSS.TASK_BP, cpu.regEBP);
    cpu.setShort(addrOld + X86.TSS.TASK_SI, cpu.regESI);
    cpu.setShort(addrOld + X86.TSS.TASK_DI, cpu.regEDI);
    cpu.setShort(addrOld + X86.TSS.TASK_ES, cpu.segES.sel);
    cpu.setShort(addrOld + X86.TSS.TASK_CS, cpu.segCS.sel);
    cpu.setShort(addrOld + X86.TSS.TASK_SS, cpu.segSS.sel);
    cpu.setShort(addrOld + X86.TSS.TASK_DS, cpu.segDS.sel);
    var offSS = X86.TSS.TASK_SS;
    var offSP = X86.TSS.TASK_SP;
    cpu.setPS(cpu.getShort(addrNew + X86.TSS.TASK_PS) | (fNest? X86.PS.NT : 0));
    cpu.assert(!fNest || !!(cpu.regPS & X86.PS.NT));
    cpu.regEAX = cpu.getShort(addrNew + X86.TSS.TASK_AX);
    cpu.regECX = cpu.getShort(addrNew + X86.TSS.TASK_CX);
    cpu.regEDX = cpu.getShort(addrNew + X86.TSS.TASK_DX);
    cpu.regEBX = cpu.getShort(addrNew + X86.TSS.TASK_BX);
    cpu.regEBP = cpu.getShort(addrNew + X86.TSS.TASK_BP);
    cpu.regESI = cpu.getShort(addrNew + X86.TSS.TASK_SI);
    cpu.regEDI = cpu.getShort(addrNew + X86.TSS.TASK_DI);
    cpu.segES.load(cpu.getShort(addrNew + X86.TSS.TASK_ES));
    cpu.segDS.load(cpu.getShort(addrNew + X86.TSS.TASK_DS));
    cpu.setCSIP(cpu.getShort(addrNew + X86.TSS.TASK_IP), cpu.getShort(addrNew + X86.TSS.TASK_CS));
    if (this.cpl < cplOld) {
        offSP = (this.cpl << 2) + X86.TSS.CPL0_SP;
        offSS = offSP + 2;
    }
    cpu.setSS(cpu.getShort(addrNew + offSS), true);
    cpu.setSP(cpu.getShort(addrNew + offSP));
    cpu.segLDT.load(cpu.getShort(addrNew + X86.TSS.TASK_LDT));
    if (fNest) cpu.setShort(addrNew + X86.TSS.PREV_TSS, selOld);
    cpu.regCR0 |= X86.CR0.MSW.TS;
    return true;
};

/**
 * loadAcc(sel, fGDT)
 *
 * @this {X86Seg}
 * @param {number} sel (protected-mode only)
 * @param {boolean} [fGDT] is true if sel must be in the GDT
 * @return {number} acc field from descriptor, or X86.DESC.ACC.INVALID if error
 */
X86Seg.prototype.loadAcc = function(sel, fGDT)
{
    var addrDT;
    var addrDTLimit;
    var cpu = this.cpu;

    if (!(sel & X86.SEL.LDT)) {
        addrDT = cpu.addrGDT;
        addrDTLimit = cpu.addrGDTLimit;
    } else if (!fGDT) {
        addrDT = cpu.segLDT.base;
        addrDTLimit = (addrDT + cpu.segLDT.limit)|0;
    }
    if (addrDT !== undefined) {
        var addrDesc = (addrDT + (sel & X86.SEL.MASK))|0;
        if (((addrDTLimit - addrDesc)|0) >= 7) {
            return cpu.getShort(addrDesc + X86.DESC.ACC.OFFSET);
        }
    }
    X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, sel);
    return X86.DESC.ACC.INVALID;
};

/**
 * loadDesc6(addrDesc, sel)
 *
 * Used to load a protected-mode selector that refers to a 6-byte "descriptor cache" (aka LOADALL) entry:
 *
 *      word 0: base address low
 *      word 1: base address high (0-7), segment type (8-11), descriptor type (12), DPL (13-14), present bit (15)
 *      word 2: segment limit (0-15)
 *
 * @this {X86Seg}
 * @param {number} addrDesc is the descriptor address
 * @param {number} sel is the associated selector
 * @return {number} base address of selected segment
 */
X86Seg.prototype.loadDesc6 = function(addrDesc, sel)
{
    var cpu = this.cpu;
    var acc = cpu.getShort(addrDesc + 2);
    var base = cpu.getShort(addrDesc) | ((acc & 0xff) << 16);
    var limit = cpu.getShort(addrDesc + 4);

    this.sel = sel;
    this.base = base;
    this.limit = limit;
    this.offMax = (limit >>> 0) + 1;
    this.acc = acc & X86.DESC.ACC.MASK;
    this.type = (acc & X86.DESC.ACC.TYPE.MASK);
    this.ext = 0;
    this.addrDesc = addrDesc;
    this.updateMode(true);

    this.messageSeg(sel, base, limit, acc);

    return base;
};

/**
 * loadDesc8(addrDesc, sel, fSuppress)
 *
 * Used to load a protected-mode selector that refers to an 8-byte "descriptor table" (GDT, LDT, IDT) entry:
 *
 *      word 0: segment limit (0-15)
 *      word 1: base address low
 *      word 2: base address high (0-7), segment type (8-11), descriptor type (12), DPL (13-14), present bit (15)
 *      word 3: used only on 80386 and up (should be set to zero for upward compatibility)
 *
 * See X86.DESC for offset and bit definitions.
 *
 * @this {X86Seg}
 * @param {number} addrDesc is the descriptor address
 * @param {number} sel is the associated selector, or nIDT*8 if IDT descriptor
 * @param {boolean} [fSuppress] is true to suppress any errors, cycle assessment, etc
 * @return {number} base address of selected segment, or ADDR_INVALID if error
 */
X86Seg.prototype.loadDesc8 = function(addrDesc, sel, fSuppress)
{
    var cpu = this.cpu;
    var limit = cpu.getShort(addrDesc + X86.DESC.LIMIT.OFFSET);
    var acc = cpu.getShort(addrDesc + X86.DESC.ACC.OFFSET);
    var type = (acc & X86.DESC.ACC.TYPE.MASK);
    var base = cpu.getShort(addrDesc + X86.DESC.BASE.OFFSET) | ((acc & X86.DESC.ACC.BASE1623) << 16);
    var ext = cpu.getShort(addrDesc + X86.DESC.EXT.OFFSET);
    var selMasked = sel & X86.SEL.MASK;

    if (I386 && cpu.model >= X86.MODEL_80386) {
        base |= (ext & X86.DESC.EXT.BASE2431) << 16;
        limit |= (ext & X86.DESC.EXT.LIMIT1619) << 16;
        if (ext & X86.DESC.EXT.LIMITPAGES) limit = (limit << 12) | 0xfff;
    }

    while (true) {

        var selCode, cplPrev, addrTSS, offSP, offSS, regSPPrev, regSSPrev;

        /*
         * TODO: Consider moving the following chunks of code into worker functions for each X86Seg.ID;
         * however, it's not clear that these tests are more costly than making additional function calls.
         */
        if (this.id == X86Seg.ID.CODE) {
            this.fStackSwitch = false;
            var fCall = this.fCall;
            var fGate, regPSMask, nFaultError, regSP;
            var rpl = sel & X86.SEL.RPL;
            var dpl = (acc & X86.DESC.ACC.DPL.MASK) >> X86.DESC.ACC.DPL.SHIFT;

            if (selMasked && !(acc & X86.DESC.ACC.PRESENT)) {
                if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.NP_FAULT, sel);
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }

            /*
             * Since we are X86Seg.ID.CODE, we can use this.cpl instead of the more generic cpu.segCS.cpl
             */
            if (type >= X86.DESC.ACC.TYPE.CODE_EXECONLY) {
                rpl = sel & X86.SEL.RPL;
                if (rpl > this.cpl) {
                    /*
                     * If fCall is false, then we must have a RETF to a less privileged segment, which is OK.
                     *
                     * Otherwise, we must be dealing with a CALLF or JMPF to a less privileged segment, in which
                     * case either DPL == CPL *or* the new segment is conforming and DPL <= CPL.
                     */
                    if (fCall !== false && !(dpl == this.cpl || (acc & X86.DESC.ACC.TYPE.CONFORMING) && dpl <= this.cpl)) {
                        base = addrDesc = X86.ADDR_INVALID;
                        break;
                    }
                    regSP = cpu.popWord();
                    cpu.setSS(cpu.popWord(), true);
                    cpu.setSP(regSP);
                    this.fStackSwitch = true;
                }
                fGate = false;
            }
            else if (type == X86.DESC.ACC.TYPE.GATE_CALL) {
                fGate = true;
                regPSMask = ~0;
                nFaultError = sel;
                if (rpl < this.cpl) rpl = this.cpl;     // set RPL to max(RPL,CPL) for call gates
            }
            else if (type == X86.DESC.ACC.TYPE.GATE_INT) {
                fGate = true;
                regPSMask = ~(X86.PS.NT | X86.PS.TF | X86.PS.IF);
                nFaultError = sel | X86.ERRCODE.EXT;
                cpu.assert(!(acc & 0x1f));
            }
            else if (type == X86.DESC.ACC.TYPE.GATE_TRAP) {
                fGate = true;
                regPSMask = ~(X86.PS.NT | X86.PS.TF);
                nFaultError = sel | X86.ERRCODE.EXT;
                cpu.assert(!(acc & 0x1f));
            }
            else if (type == X86.DESC.ACC.TYPE.GATE_TASK) {
                if (!this.switchTSS(base & 0xffff, true)) {
                    base = addrDesc = X86.ADDR_INVALID;
                    break;
                }
                return this.base;
            }
            if (fGate) {
                /*
                 * Note that since GATE_INT/GATE_TRAP descriptors should appear in the IDT only, that means sel
                 * will actually be nIDT * 8, which means the rpl will always be zero; additionally, the nWords
                 * portion of acc should always be zero, but that's really dependent on the descriptor being properly
                 * set (which we assert above).
                 */
                selCode = base & 0xffff;
                if (rpl <= dpl) {
                    /*
                     * TODO: Verify the PRESENT bit of the gate descriptor, and issue NP_FAULT as appropriate.
                     */
                    cplPrev = this.cpl;
                    if (this.load(selCode, true) === X86.ADDR_INVALID) {
                        cpu.assert(false);
                        base = addrDesc = X86.ADDR_INVALID;
                        break;
                    }
                    cpu.regEIP = limit;
                    if (this.cpl < cplPrev) {
                        if (fCall !== true) {
                            cpu.assert(false);
                            base = addrDesc = X86.ADDR_INVALID;
                            break;
                        }
                        regSP = cpu.getSP();
                        var i = 0, nWords = (acc & 0x1f);
                        while (nWords--) {
                            this.awParms[i++] = cpu.getSOWord(cpu.segSS, regSP);
                            regSP += 2;
                        }
                        addrTSS = cpu.segTSS.base;
                        offSP = (this.cpl << 2) + X86.TSS.CPL0_SP;
                        offSS = offSP + 2;
                        regSSPrev = cpu.getSS();
                        regSPPrev = cpu.getSP();
                        cpu.setSS(cpu.getShort(addrTSS + offSS), true);
                        cpu.setSP(cpu.getShort(addrTSS + offSP));
                        cpu.pushWord(regSSPrev);
                        cpu.pushWord(regSPPrev);
                        while (i) cpu.pushWord(this.awParms[--i]);
                        this.fStackSwitch = true;
                    }
                    cpu.regPS &= regPSMask;
                    return this.base;
                }
                cpu.assert(false);
                if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, nFaultError, true);
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }
            else if (fGate !== false) {
                cpu.assert(false);
                if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, sel, true);
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }
        }
        else if (this.id == X86Seg.ID.DATA) {
            if (selMasked) {
                if (!(acc & X86.DESC.ACC.PRESENT)) {
                    if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.NP_FAULT, sel);
                    base = addrDesc = X86.ADDR_INVALID;
                    break;
                }
                if (type < X86.DESC.ACC.TYPE.SEG || (type & (X86.DESC.ACC.TYPE.CODE | X86.DESC.ACC.TYPE.READABLE)) == X86.DESC.ACC.TYPE.CODE) {
                    /*
                     * OS/2 1.0 triggers this "Empty Descriptor" GP_FAULT multiple times during boot; eg:
                     *
                     *      Fault 0D (002F) on opcode 0x8E at 3190:3A05 (%112625)
                     *      stopped (11315208 ops, 41813627 cycles, 498270 ms, 83918 hz)
                     *      AX=0000 BX=0970 CX=0300 DX=0300 SP=0ABE BP=0ABA SI=0000 DI=001A
                     *      DS=19C0[177300,2C5F] ES=001F[1743A0,07FF] SS=0038[175CE0,0B5F]
                     *      CS=3190[10EC20,B89F] IP=3A05 V0 D0 I1 T0 S0 Z1 A0 P1 C0 PS=3246 MS=FFF3
                     *      LD=0028[174BC0,003F] GD=[11A4E0,490F] ID=[11F61A,03FF]  TR=0010 A20=ON
                     *      3190:3A05 8E4604        MOV      ES,[BP+04]
                     *      0038:0ABE  002F  19C0  0000  067C - 07FC  0AD2  0010  C420   /.....|....... .
                     *      dumpDesc(002F): %174BE8
                     *      base=000000 limit=0000 dpl=00 type=00 (undefined)
                     *
                     * If we allow the GP fault to be dispatched, it recovers, so until I'm able to investigate this
                     * further, I'm going to assume this is normal behavior.  If the segment (0x002F in the example)
                     * simply needed to be "faulted" into memory, I would have expected OS/2 to build a descriptor
                     * with the PRESENT bit clear, and rely on NP_FAULT rather than GP_FAULT, but maybe this was simpler.
                     *
                     * Anyway, because of this, if acc is zero, we won't set fHalt on this GP_FAULT.
                     */
                    if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, sel, !!acc);
                    base = addrDesc = X86.ADDR_INVALID;
                    break;
                }
            }
        }
        else if (this.id == X86Seg.ID.STACK) {
            if (!(acc & X86.DESC.ACC.PRESENT)) {
                if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.SS_FAULT, sel);
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }
            if (!selMasked || type < X86.DESC.ACC.TYPE.SEG || (type & (X86.DESC.ACC.TYPE.CODE | X86.DESC.ACC.TYPE.WRITABLE)) != X86.DESC.ACC.TYPE.WRITABLE) {
                if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.GP_FAULT, sel, true);
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }
        }
        else if (this.id == X86Seg.ID.TSS) {
            if (!selMasked || type != X86.DESC.ACC.TYPE.TSS && type != X86.DESC.ACC.TYPE.TSS_BUSY) {
                if (!fSuppress) X86.fnFault.call(cpu, X86.EXCEPTION.TS_FAULT, sel, true);
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }
        }
        else if (this.id == X86Seg.ID.OTHER) {
            /*
             * For LSL, we must support any descriptor marked X86.DESC.ACC.TYPE.SEG, as well as TSS and LDT descriptors.
             */
            if (!(acc & X86.DESC.ACC.TYPE.SEG) && type > X86.DESC.ACC.TYPE.TSS_BUSY) {
                base = addrDesc = X86.ADDR_INVALID;
                break;
            }
        }
        this.sel = sel;
        this.base = base;
        this.limit = limit;
        this.offMax = (limit >>> 0) + 1;
        this.acc = acc;
        this.type = type;
        this.ext = ext;
        this.addrDesc = addrDesc;
        this.updateMode(true);
        break;
    }
    if (!fSuppress) this.messageSeg(sel, base, limit, acc, ext);
    return base;
};

/**
 * setBase(addr)
 *
 * This is used in unusual situations where the base must be set independently; normally, the base
 * is set according to the selector provided to load(), but there are a few cases where setBase()
 * is required.
 *
 * For example, in resetRegs(), the real-mode CS selector must be reset to 0xF000 for an 80286 or 80386,
 * but the CS base must be set to 0x00FF0000 or 0xFFFF0000, respectively.  To simplify life for setBase()
 * callers, we allow them to specify 32-bit bases, which we then truncate to 24 bits as needed.
 *
 * @this {X86Seg}
 * @param {number} addr
 * @return {number} addr, truncated as needed
 */
X86Seg.prototype.setBase = function(addr)
{
    if (this.cpu.model < X86.MODEL_80386) addr &= 0xffffff;
    return this.base = addr;
};

/**
 * save()
 *
 * Early versions of PCjs saved only segment selectors, since that's all that mattered in real-mode;
 * newer versions need to save/restore all the "defining" properties of the X86Seg object.
 *
 * @this {X86Seg}
 * @return {Array}
 */
X86Seg.prototype.save = function()
{
    return [
        this.sel,
        this.base,
        this.limit,
        this.acc,
        this.id,
        this.sName,
        this.cpl,
        this.dpl,
        this.addrDesc,
        this.addrSize,
        this.addrMask,
        this.dataSize,
        this.dataMask,
        this.type,
        this.offMax
    ];
};

/**
 * restore(a)
 *
 * Early versions of PCjs saved only segment selectors, since that's all that mattered in real-mode;
 * newer versions need to save/restore all the "defining" properties of the X86Seg object.
 *
 * @this {X86Seg}
 * @param {Array|number} a
 */
X86Seg.prototype.restore = function(a)
{
    if (typeof a == "number") {
        this.load(a);
    } else {
        this.sel      = a[0];
        this.base     = a[1];
        this.limit    = a[2];
        this.acc      = a[3];
        this.id       = a[4];
        this.sName    = a[5];
        this.cpl      = a[6];
        this.dpl      = a[7];
        this.addrDesc = a[8];
        this.addrSize = a[9]  || 2;
        this.addrMask = a[10] || 0xffff;
        this.dataSize = a[11] || 2;
        this.dataMask = a[12] || 0xffff;
        this.type     = a[13] || (this.acc & X86.DESC.ACC.TYPE.MASK);
        this.offMax   = a[14] || (this.limit >>> 0) + 1;
    }
};

/**
 * updateMode(fLoad, fProt)
 *
 * Ensures that the segment register's access (ie, load and check methods) matches the specified (or current)
 * operating mode (real or protected).
 *
 * @this {X86Seg}
 * @param {boolean} [fLoad] true if the segment was just (re)loaded, false if not
 * @param {boolean} [fProt] true for protected-mode access, false for real-mode access, undefined for current mode
 * @return {boolean}
 */
X86Seg.prototype.updateMode = function(fLoad, fProt)
{
    if (fProt === undefined) {
        fProt = !!(this.cpu.regCR0 & X86.CR0.MSW.PE);
    }

    /*
     * The following properties are used for STACK segments only (ie, segSS); we want to make it easier
     * for setSS() to set stack lower and upper limits, which requires knowing whether or not the segment is
     * marked as EXPDOWN.
     */
    this.fExpDown = false;

    if (fProt) {
        this.load = this.loadProt;
        this.loadIDT = this.loadIDTProt;
        this.checkRead = this.checkReadProt;
        this.checkWrite = this.checkWriteProt;

        /*
         * TODO: For null GDT selectors, should we rely on the descriptor being invalid, or should we assume that
         * the null descriptor might contain uninitialized (or other) data?  I'm assuming the latter, hence the
         * following null selector test.  However, if we're not going to consult the descriptor, is there anything
         * else we should (or should not) be doing for null GDT selectors?
         */
        if (!(this.sel & ~X86.SEL.RPL)) {
            this.checkRead = this.checkReadProtDisallowed;
            this.checkWrite = this.checkWriteProtDisallowed;

        }
        else if (this.acc & X86.DESC.ACC.TYPE.SEG) {
            /*
             * If the READABLE bit of CODE_READABLE is not set, then disallow reads.
             */
            if ((this.acc & X86.DESC.ACC.TYPE.CODE_READABLE) == X86.DESC.ACC.TYPE.CODE_EXECONLY) {
                this.checkRead = this.checkReadProtDisallowed;
            }
            /*
             * If the CODE bit is set, or the the WRITABLE bit is not set, then disallow writes.
             */
            if ((this.acc & X86.DESC.ACC.TYPE.CODE) || !(this.acc & X86.DESC.ACC.TYPE.WRITABLE)) {
                this.checkWrite = this.checkWriteProtDisallowed;
            }
            /*
             * If the CODE bit is not set *and* the EXPDOWN bit is set, then invert the limit check.
             */
            if ((this.acc & (X86.DESC.ACC.TYPE.CODE | X86.DESC.ACC.TYPE.EXPDOWN)) == X86.DESC.ACC.TYPE.EXPDOWN) {
                if (this.checkRead == this.checkReadProt) this.checkRead = this.checkReadProtDown;
                if (this.checkWrite == this.checkWriteProt) this.checkWrite = this.checkWriteProtDown;
                this.fExpDown = true;
            }
        }
        /*
         * TODO: For non-SEG descriptors, are there other checks or functions we should establish?
         */

        /*
         * Any update to the following properties must occur only on segment loads, not simply when
         * we're updating segment registers as part of a mode change.
         */
        if (fLoad) {
            /*
             * We must update the descriptor's ACCESSED bit whenever the segment is "accessed" (ie,
             * loaded); unlike the ACCESSED and DIRTY bits in PTEs, a descriptor ACCESSED bit is only
             * updated on loads, not on every memory access.
             *
             * We compute address of the descriptor byte containing the ACCESSED bit (offset 0x5);
             * note that it's perfectly normal for addrDesc to occasionally be invalid (eg, when the CPU
             * is creating protected-mode-only segment registers like LDT and TSS, or when the CPU has
             * transitioned from real-mode to protected-mode and new selector(s) have not been loaded yet).
             *
             * TODO: Note I do NOT update the ACCESSED bit for null GDT selectors, because I assume the
             * hardware does not update it either.  In fact, I've seen code that uses the null GDT descriptor
             * for other purposes, on the assumption that that descriptor is completely unused.
             */
            if ((this.sel & ~X86.SEL.RPL) && this.addrDesc !== X86.ADDR_INVALID) {
                var addrACC = this.addrDesc + X86.DESC.ACC.TYPE.OFFSET;
                this.cpu.setByte(addrACC, this.cpu.getByte(addrACC) | (X86.DESC.ACC.TYPE.ACCESSED >> 8));
            }
            this.cpl = this.sel & X86.SEL.RPL;
            this.dpl = (this.acc & X86.DESC.ACC.DPL.MASK) >> X86.DESC.ACC.DPL.SHIFT;
            if (this.cpu.model < X86.MODEL_80386 || !(this.ext & X86.DESC.EXT.BIG)) {
                this.dataSize = 2;
                this.dataMask = 0xffff;
            } else {
                this.dataSize = 4;
                this.dataMask = (0xffffffff|0);
            }
            this.addrSize = this.dataSize;
            this.addrMask = this.dataMask;
        }
    } else {
        this.load = this.loadReal;
        this.loadIDT = this.loadIDTReal;
        this.checkRead = this.checkReadReal;
        this.checkWrite = this.checkWriteReal;
        this.cpl = this.dpl = 0;
        this.addrDesc = X86.ADDR_INVALID;
    }
    return fProt;
};

/**
 * messageSeg(sel, base, limit, acc, ext)
 *
 * @this {X86Seg}
 * @param {number} sel
 * @param {number} base
 * @param {number} limit
 * @param {number} acc
 * @param {number} [ext]
 */
X86Seg.prototype.messageSeg = function(sel, base, limit, acc, ext)
{
    if (DEBUG) {
        if (DEBUGGER && this.dbg && this.dbg.messageEnabled(Messages.SEG)) {
            var ch = (this.sName.length < 3? " " : "");
            var sDPL = " dpl=" + this.dpl;
            if (this.id == X86Seg.ID.CODE) sDPL += " cpl=" + this.cpl;
            this.dbg.message("loadSeg(" + this.sName + "):" + ch + "sel=" + str.toHexWord(sel) + " base=" + str.toHex(base) + " limit=" + str.toHexWord(limit) + " acc=" + str.toHexWord(acc) + sDPL);
        }
        this.cpu.assert(/* base !== X86.ADDR_INVALID && */ (this.cpu.model >= X86.MODEL_80386 || !ext || ext == X86.DESC.EXT.AVAIL));
    }
};

if (typeof module !== 'undefined') module.exports = X86Seg;
