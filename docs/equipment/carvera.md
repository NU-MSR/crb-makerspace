# CNC Milling Machine

![Carvera CNC](../assets/carvera.jpg){ width="600" }

The CRB Makerspace Shop has a Carvera CNC milling machine. You must complete machine-specific training before being authorized to use this machine. **Do not cut steel on this machine.**

## Hazard level

<span style="background-color: orange; color: white; padding: 4px 8px; border-radius: 4px; font-size: 2.2em; font-weight: bold;">ORANGE</span>

!!! warning

    - The Carvera is programmed to stop spindle operation when the lid is opened. **Do not change this setting or override the interlocks.** Contact with the high-speed cutting tool or flying chips and metal fragments can cause injury when the enclosure is open.
    - Part edges and chips can be sharp
    - Risk of unexpected machine movement from programming errors
    - Hot cutting tools and workpiece after operation

## Safety

- **Never leave the machine running unattended.** Hit the e-stop if anything goes wrong.
- Clear chips with brush/vacuum, never hands or compressed air.

## Getting started

The best way to get acquainted with the machine is to go through the tutorial videos provided by Makera.

[Tutorial Videos](https://wiki.makera.com/en/carvera/How-To){ .md-button .md-button--primary }

## Speeds and Feeds

**ALWAYS** confirm you are using the correct spindle speeds (in RPM), feed rate (in mm/s), and depth of cut (in mm) for your bit and material before running your program by referencing the official table from Makera!

[Speeds and Feeds Table](https://wiki.makera.com/en/speeds-and-feeds){ .md-button .md-button--primary }

## Instructions for use

- Download profiles for your CAM software of choice from Makera [HERE](https://wiki.makera.com/en/software).
    - Note: The Makerspace has a license for [Makera CAM](https://www.makera.com/pages/makera-cam) if needed. Reach out to management for details.
- Create the CAM paths for your part.

!!! warning

    Issues have been found in the speeds and feeds from the profiles for Autodesk Fusion and Kiri:Moto. Do not trust them on their own. **[Verify the speeds with the official table.](https://wiki.makera.com/en/speeds-and-feeds)**

- **Always double check your settings with the [feeds and speeds table](https://wiki.makera.com/en/speeds-and-feeds) for your bit.**
    - Make sure you are using the right tool for your material.
    - Make sure the spindle speed and feed rates are correct.
    - Make sure the tool is in the right tool position for your CAM program.
- Load your material into the Carvera. Make sure it is securely held in place with screws, clamps, and/or double sided tape. Check your stock height and **make sure there is MDF underneath**.
- Make sure the correct cutting tools are in the correct tool positions.
- Connect to the machine using the [Carvera Controller](https://www.makera.com/pages/software#MakeraController) app from your laptop or the attached tablet.
- Load your gcode file onto the machine.
- Run your program, being sure to set the correct work origin and Z probe position (where it will measure the Z height of your stock). You can optionally set Auto Leveling if you only care about the cutting depth relative to the top of the piece (e.g. for PCB milling). Be sure to keep Scan Margin enabled to have the machine trace out a bounding box with the laser.
    - **Be sure to confirm that there is no interference between the cutting tool and the mounting hardware.** The laser bounding box should help with this, but does not capture the width of the cutting tools.

## Manual

<iframe
    src="../../manuals/carvera-instruction-manual.pdf"
    width="100%"
    height="1100px"
    style="border:none;"
></iframe>