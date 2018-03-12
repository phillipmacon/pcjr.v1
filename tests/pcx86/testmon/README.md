---
layout: page
title: PCx86 TestMonitor Support
permalink: /tests/pcx86/testmon/
---

PCx86 TestMonitor Support
-------------------------

When the PCjs [TestMonitor](/modules/pcx86/lib/testmon.js) component is being used to control either a real or
simulated x86 PC, it is currently loaded with the following set of test commands:

- [tests.json](tests.json)

Over time, more general-purpose sets of tests will be added here.
 
Also, when using a real PC, the [INT14.ASM](int14/) Terminate-and-Stay-Resident (TSR) utility should be installed, to
minimize the risk of dropped characters when using the DOS "CTTY" command.