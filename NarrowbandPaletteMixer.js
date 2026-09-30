#engine v8

#feature-id NarrowbandPaletteMixer : Custom > Narrowband Palette Mixer
#feature-info Mixes Ha, OIII and SII into a colour image with adjustable channel percentages, normalisation, stretch strength, Ha luminance, green removal and saturation, with a live preview.

CoreApplication.ensureMinimumVersion( 1, 9, 4 );

/******************************************************************************
 * Narrowband Palette Mixer
 * Version: 1.3
 *
 * Based on Perfect Palette Picker v1.3 by Franklin Marek (www.setiastro.com),
 * licensed under Creative Commons Attribution-NonCommercial 4.0
 * International. This derivative is distributed under the same licence.
 *
 * Changes from Perfect Palette Picker:
 *   - Palettes are a 3x3 mix of Ha, SII and OIII into R, G and B, set with
 *     sliders and shown in a live preview. Presets load a starting mix.
 *   - OIII and SII are normalised to the Ha signal level before mixing, so
 *     weak lines are not swamped by Ha.
 *   - Mixing happens on linear data around a common background, followed by
 *     one STF-style stretch with an adjustable target background. The
 *     background stays neutral whatever the mix.
 *   - Optional Ha luminance, green removal (SCNR average neutral) and
 *     saturation.
 *   - v1.1: a low percentile of each channel (Dark reference %) is the
 *     neutral black point, not the median, so dust lanes stay neutral when
 *     nebulosity fills the frame.
 *   - v1.2: statistics ignore zero/clipped pixels, which made the dark
 *     reference ineffective on gradient-corrected data.
 *   - v1.3: New Instance button saves the settings and channel choices as a
 *     process icon.
 ******************************************************************************/

#define VERSION      "1.3"
#define SETTINGS_KEY "NarrowbandPaletteMixer"

// Longest side, in pixels, of the working preview image.
#define PREVIEW_MAX  1200
// Longest side, in pixels, of each preset tile.
#define TILE_MAX     320
// Rows processed per block when generating the full-size image.
#define STRIP_ROWS   256
// Percentile of the downsampled channel treated as its "signal level".
#define SIGNAL_QUANTILE 0.95
// Samples below this are treated as clipped (gradient-removal truncation,
// registration borders) and ignored by all statistics.
#define ZERO_FLOOR   1.0e-6

// ============================================================================
// Presets: percentage of each line sent to [R, G, B]
// ============================================================================

const PRESETS = [
    { name: "Copper & Blue",    H: [  90, 45,  0 ], S: [  80, 30, 0 ], O: [   0,  50, 140 ] },
    { name: "Red & Blue",       H: [ 100, 20,  5 ], S: [ 100, 50, 0 ], O: [   0,  45, 150 ] },
    { name: "Gold & Blue",      H: [  70, 45,  0 ], S: [ 100, 40, 0 ], O: [   0,  35, 140 ] },
    { name: "Ha Red / OIII Teal", H: [ 100, 0, 0 ], S: [  60, 40, 0 ], O: [   0,  80, 100 ] },
    { name: "Realistic",        H: [  70,  0,  0 ], S: [  30, 30, 0 ], O: [   0,  70, 100 ] },
    { name: "HOO",              H: [ 100,  0,  0 ], S: [   0,  0, 0 ], O: [   0, 100, 100 ] },
    { name: "SHO",              H: [   0,100,  0 ], S: [ 100,  0, 0 ], O: [   0,   0, 100 ] },
    { name: "HSO",              H: [ 100,  0,  0 ], S: [   0,100, 0 ], O: [   0,   0, 100 ] }
];

const DEFAULTS = {
    preset:    0,
    linear:    true,
    normalise: true,
    target:    0.15,   // background level after stretch (original script: 0.25)
    clip:      2.8,    // shadow clipping, in sigma below the background
    darkRef:   10,     // % percentile of each line treated as neutral black
    haLum:     50,     // % of luminance taken from stretched Ha
    green:     0,      // % green removal
    sat:       130     // % saturation
};

// @@ENGINE-BEGIN
// ============================================================================
// Palette engine: pure maths, no PJSR objects, so it can be tested outside
// PixInsight. The same code renders the preview, tiles and final image.
// ============================================================================

// Midtones transfer function, as used by STF and HistogramTransformation.
function mtf( m, x )
{
    if ( x <= 0 ) return 0;
    if ( x >= 1 ) return 1;
    return ((m - 1)*x) / ((2*m - 1)*x - m);
}

function sortedCopy( a )
{
    let s = new Float32Array( a );
    s.sort();
    return s;
}

function quantileOfSorted( s, q )
{
    let i = Math.round( q*(s.length - 1) );
    return s[Math.max( 0, Math.min( s.length - 1, i ) )];
}

// Drops sorted samples below floor: pixels clipped to zero by gradient
// removal, and black registration borders. Without this, low percentiles all
// read 0 and the dark reference has no effect. Keeps everything if almost
// the whole channel is below floor.
function trimClipped( sorted, floor )
{
    let i = 0;
    while ( i < sorted.length && sorted[i] < floor )
        ++i;
    return (sorted.length - i >= 0.05*sorted.length) ? sorted.subarray( i ) : sorted;
}

// Shadows clipping point and midtones balance that map a background level to
// the requested target, like an STF auto-stretch.
function makeStretch( bg, sigma, opts )
{
    if ( !opts.linear )
        return { bp: 0, m: 0.5 };
    let bp = bg - opts.clip*sigma;
    if ( bp >= bg )
        bp = bg - 1.0e-6;
    let x0 = (bg - bp)/(1 - bp);
    return { bp: bp, m: mtf( opts.target, x0 ) };
}

// stats: { H, O, S }, each null or
//   { median, mad }           full-resolution median and (raw) MAD
//   { pMedian, pHigh }        downsampled median and signal-level percentile
//   { sorted }                downsampled samples, sorted, for dark levels
// weights: { H, O, S }, each [r, g, b] as fractions (1 = 100%).
// opts: { linear, normalise, target, clip, darkRef, haLum, green, sat }
//       (fractions).
//
// Each output channel is:
//   lin_c = dark_H + sum_k w_kc * g_k * (x_k - dark_k)
// where g_k scales line k so its signal level matches Ha, and dark_k is the
// darkRef percentile of line k. Where every line sits at its dark level, all
// channels are equal, so the darkest areas stay neutral for any mix. Using a
// low percentile rather than the median matters when nebulosity fills the
// frame: the median is then faint nebula, and dust lanes below it would take
// on the colour of whichever line is flattest (usually OIII, giving blue).
function computeCoefficients( stats, weights, opts )
{
    const keys = [ "H", "O", "S" ];
    let ref = stats.H;
    let bg  = ref.median;   // Ha median: stretch anchor for Ha luminance
    let refRange = ref.pHigh - ref.pMedian;
    let dark = s => quantileOfSorted( s.sorted, opts.darkRef );

    let gain = {};
    for ( let k of keys )
    {
        let s = stats[k];
        let g = 0;
        if ( s )
        {
            g = 1;
            if ( opts.normalise )
            {
                let d = s.pHigh - s.pMedian;
                if ( d > 1.0e-8 && refRange > 1.0e-8 )
                    g = refRange/d;
            }
        }
        gain[k] = g;
    }

    let A = [], K = [];
    for ( let c = 0; c < 3; ++c )
    {
        let row = [], k0 = dark( ref );
        for ( let k of keys )
        {
            let s = stats[k];
            let a = s ? weights[k][c]*gain[k] : 0;
            row.push( a );
            if ( s )
                k0 -= a*dark( s );
        }
        A.push( row );
        K.push( k0 );
    }

    // One linked stretch for every channel. Per-channel stretches would
    // stretch a boosted (noisier) line less and shift the colour balance.
    // The anchor is the mean mixed level where every line sits at its median,
    // so moving the dark reference changes colour balance, not brightness or
    // contrast. With darkRef = 50% this reduces to the Ha median, as in
    // version 1.0.
    let mixBg = 0;
    for ( let c = 0; c < 3; ++c )
    {
        let v = K[c];
        for ( let j = 0; j < 3; ++j )
            if ( stats[keys[j]] )
                v += A[c][j]*stats[keys[j]].median;
        mixBg += v/3;
    }
    let sigma = Math.max( 1.4826*ref.mad, 1.0e-7 );
    let st = makeStretch( mixBg, sigma, opts );

    return {
        A: A, K: K,
        bp: [ st.bp, st.bp, st.bp ],
        m:  [ st.m, st.m, st.m ],
        lumStretch: makeStretch( bg, sigma, opts ),
        hasO:  !!stats.O,
        gain:  gain,
        haLum: opts.haLum,
        green: opts.green,
        sat:   opts.sat
    };
}

// h, o, s: Float32Array (o may be null). Writes n pixels to outR/G/B.
function processPixels( h, o, s, n, coef, outR, outG, outB )
{
    const A = coef.A, K = coef.K;
    const a00 = A[0][0], a01 = A[0][1], a02 = A[0][2];
    const a10 = A[1][0], a11 = A[1][1], a12 = A[1][2];
    const a20 = A[2][0], a21 = A[2][1], a22 = A[2][2];
    const k0 = K[0], k1 = K[1], k2 = K[2];
    const bp0 = coef.bp[0], bp1 = coef.bp[1], bp2 = coef.bp[2];
    const i0 = 1/(1 - bp0), i1 = 1/(1 - bp1), i2 = 1/(1 - bp2);
    const m0 = coef.m[0], m1 = coef.m[1], m2 = coef.m[2];
    const bpL = coef.lumStretch.bp, iL = 1/(1 - bpL), mL = coef.lumStretch.m;
    const lum = coef.haLum, green = coef.green, sat = coef.sat;
    const useO = coef.hasO && o;

    for ( let i = 0; i < n; ++i )
    {
        let hv = h[i], ov = useO ? o[i] : 0, sv = s[i];

        let r = mtf( m0, (k0 + a00*hv + a01*ov + a02*sv - bp0)*i0 );
        let g = mtf( m1, (k1 + a10*hv + a11*ov + a12*sv - bp1)*i1 );
        let b = mtf( m2, (k2 + a20*hv + a21*ov + a22*sv - bp2)*i2 );

        if ( green > 0 )
        {
            let nn = 0.5*(r + b);
            if ( g > nn )
                g -= green*(g - nn);
        }

        if ( lum > 0 )
        {
            // Pull luminance towards stretched Ha. The +0.1 damping stops the
            // ratio exploding in dark areas where L is close to zero.
            let L  = (r + g + b)/3;
            let hl = mtf( mL, (hv - bpL)*iL );
            let f  = (L + lum*(hl - L) + 0.1)/(L + 0.1);
            r *= f; g *= f; b *= f;
        }

        if ( sat != 1 )
        {
            let L = (r + g + b)/3;
            r = L + sat*(r - L);
            g = L + sat*(g - L);
            b = L + sat*(b - L);
        }

        outR[i] = r < 0 ? 0 : (r > 1 ? 1 : r);
        outG[i] = g < 0 ? 0 : (g > 1 ? 1 : g);
        outB[i] = b < 0 ? 0 : (b > 1 ? 1 : b);
    }
}
// @@ENGINE-END

// ============================================================================
// Channel loading helpers
// ============================================================================

// Copies channel c of a colour image into a new single-channel Image.
function extractChannel( srcImage, c )
{
    let w = srcImage.width, h = srcImage.height;
    let out = new Image( w, h, 1 );
    for ( let y0 = 0; y0 < h; y0 += STRIP_ROWS )
    {
        let r = new Rect( 0, y0, w, Math.min( h, y0 + STRIP_ROWS ) );
        let a = new Float32Array( r.area );
        srcImage.getSamples( a, r, c );
        out.setSamples( a, r, 0 );
    }
    return out;
}

// Average of two same-sized single-channel sources (image, channel) pairs.
function averageChannels( img1, c1, img2, c2 )
{
    let w = img1.width, h = img1.height;
    let out = new Image( w, h, 1 );
    for ( let y0 = 0; y0 < h; y0 += STRIP_ROWS )
    {
        let r = new Rect( 0, y0, w, Math.min( h, y0 + STRIP_ROWS ) );
        let a = new Float32Array( r.area ), b = new Float32Array( r.area );
        img1.getSamples( a, r, c1 );
        img2.getSamples( b, r, c2 );
        for ( let i = 0; i < a.length; ++i )
            a[i] = 0.5*(a[i] + b[i]);
        out.setSamples( a, r, 0 );
    }
    return out;
}

// Returns { image, preview: Float32Array, pw, ph, stats } for a mono Image.
function analyseChannel( img )
{
    // Full-resolution median and noise, ignoring clipped/zero pixels.
    let stats = {};
    img.pushSelections();
    try
    {
        img.rangeClipLow  = ZERO_FLOOR;
        img.rangeClipHigh = 1;
        img.rangeClippingEnabled = true;
        stats.median = img.median();
        stats.mad    = img.MAD( stats.median );
    }
    finally
    {
        img.popSelections();
    }

    let scale = Math.min( 1, PREVIEW_MAX/Math.max( img.width, img.height ) );
    let small = new Image( img );
    if ( scale < 1 )
        small.resample( scale );
    let preview = small.toFloat32Array( small.bounds, 0 );

    let all = sortedCopy( preview );
    let sorted = trimClipped( all, ZERO_FLOOR );
    stats.clipped = 1 - sorted.length/all.length;
    stats.pMedian = quantileOfSorted( sorted, 0.5 );
    stats.pHigh   = quantileOfSorted( sorted, SIGNAL_QUANTILE );
    stats.sorted  = sorted;

    return { image: img, preview: preview, pw: small.width, ph: small.height, stats: stats };
}

// Block-averages a preview array down to tile size.
function makeTileArray( a, w, h, step )
{
    let tw = Math.floor( w/step ), th = Math.floor( h/step );
    let out = new Float32Array( tw*th ), k = 1/(step*step);
    for ( let ty = 0; ty < th; ++ty )
        for ( let tx = 0; tx < tw; ++tx )
        {
            let sum = 0;
            for ( let y = ty*step, y1 = y + step; y < y1; ++y )
                for ( let x = tx*step, x1 = x + step, i = y*w + x; x < x1; ++x, ++i )
                    sum += a[i];
            out[ty*tw + tx] = sum*k;
        }
    return { data: out, w: tw, h: th };
}

function renderBitmap( w, h, R, G, B )
{
    let img = new Image( w, h, 3, ColorSpace.RGB );
    img.setSamples( R, img.bounds, 0 );
    img.setSamples( G, img.bounds, 1 );
    img.setSamples( B, img.bounds, 2 );
    return img.render();
}

// ============================================================================
// Dialog
// ============================================================================

var NarrowbandPaletteMixerDialog = class extends Dialog
{
    constructor()
    {
        super();

        this.channels   = null;   // { H, O, S } from analyseChannel(), after load
        this.tileArrays = null;   // { H, O, S } tile-sized arrays
        this.previewBmp = null;
        this.presetIndex = DEFAULTS.preset;
        this.weights = this.presetWeights( DEFAULTS.preset );

        this.updateTimer = new Timer;
        this.updateTimer.interval   = 0.08;
        this.updateTimer.singleShot = true;
        this.updateTimer.onTimeout  = () => { this.refresh(); };
        this.tilesDirty = true;

        const labelWidth = this.font.width( "OSC S2O3 dual:" ) + 8;

        // ---------------- Left panel ----------------
        this.leftPanel = new Control( this );
        this.leftPanel.sizer = new VerticalSizer;
        this.leftPanel.sizer.spacing = 6;
        this.leftPanel.setScaledFixedWidth( 330 );

        this.titleLabel = new Label( this.leftPanel );
        this.titleLabel.text = "Narrowband Palette Mixer v" + VERSION;
        this.titleLabel.textAlignment = TextAlignment.Center;
        this.titleLabel.styleSheet = "font-size:13pt; font-weight:bold;";
        this.leftPanel.sizer.add( this.titleLabel );

        // Channels
        this.channelGroup = new GroupBox( this.leftPanel );
        this.channelGroup.title = "Channels";
        this.channelGroup.sizer = new VerticalSizer;
        this.channelGroup.sizer.margin = 6;
        this.channelGroup.sizer.spacing = 4;

        let makeCombo = ( text, tip ) =>
        {
            let label = new Label( this.channelGroup );
            label.text = text;
            label.setFixedWidth( labelWidth );
            label.textAlignment = TextAlignment.Right | TextAlignment.VertCenter;
            let combo = new ComboBox( this.channelGroup );
            combo.addItem( "— None —" );
            let wins = ImageWindow.windows;
            for ( let i = 0; i < wins.length; ++i )
                combo.addItem( wins[i].mainView.id );
            combo.toolTip = tip;
            let row = new HorizontalSizer;
            row.spacing = 4;
            row.add( label );
            row.add( combo, 1 );
            this.channelGroup.sizer.add( row );
            return combo;
        };

        this.comboHa   = makeCombo( "Ha:",   "Linear Ha master (mono)." );
        this.comboOIII = makeCombo( "OIII:", "Linear OIII master (mono)." );
        this.comboSII  = makeCombo( "SII:",  "Linear SII master (mono). If missing, Ha is used in its place." );
        this.comboOSC1 = makeCombo( "OSC HaO3 dual:", "Colour image through a Ha/OIII dual-band filter: R becomes Ha, mean of G and B becomes OIII." );
        this.comboOSC2 = makeCombo( "OSC S2O3 dual:", "Colour image through a SII/OIII dual-band filter: R becomes SII, mean of G and B becomes OIII." );
        this.autoSelectChannels();

        this.linearCheckbox = new CheckBox( this.channelGroup );
        this.linearCheckbox.text = "Linear input data";
        this.linearCheckbox.checked = DEFAULTS.linear;
        this.linearCheckbox.toolTip = "<p>Check for linear (unstretched) masters. The mixer then applies " +
            "its own stretch. Uncheck if the channels are already stretched.</p>";
        this.linearCheckbox.onCheck = () => { this.updateStretchEnabled(); this.scheduleRefresh( true ); };

        this.normaliseCheckbox = new CheckBox( this.channelGroup );
        this.normaliseCheckbox.text = "Normalise OIII and SII to Ha";
        this.normaliseCheckbox.checked = DEFAULTS.normalise;
        this.normaliseCheckbox.toolTip = "<p>Scales each line so its signal level (the " +
            Math.round( SIGNAL_QUANTILE*100 ) + "th percentile above background) matches Ha. " +
            "Without this, weak OIII and SII barely show next to Ha.</p>";
        this.normaliseCheckbox.onCheck = () => { this.scheduleRefresh( true ); };

        this.loadButton = new PushButton( this.channelGroup );
        this.loadButton.text = "Load channels";
        this.loadButton.toolTip = "Read the selected channels and build the preview.";
        this.loadButton.onClick = () => { this.loadChannels(); };

        this.channelGroup.sizer.add( this.linearCheckbox );
        this.channelGroup.sizer.add( this.normaliseCheckbox );
        this.channelGroup.sizer.add( this.loadButton );
        this.leftPanel.sizer.add( this.channelGroup );

        // Stretch
        this.stretchGroup = new GroupBox( this.leftPanel );
        this.stretchGroup.title = "Stretch";
        this.stretchGroup.sizer = new VerticalSizer;
        this.stretchGroup.sizer.margin = 6;
        this.stretchGroup.sizer.spacing = 4;

        this.targetControl = this.makeSlider( this.stretchGroup, "Background:", 0.02, 0.40, 3, 380,
            "<p>Background level after the stretch. Lower is a gentler stretch that leaves " +
            "more room to stretch further later. The original script used 0.25.</p>", true );
        this.clipControl = this.makeSlider( this.stretchGroup, "Shadow clip σ:", 0.5, 6.0, 1, 55,
            "<p>How far below the background, in noise sigmas, the black point sits. " +
            "Lower values clip more shadow; higher values keep a softer, lifted floor.</p>", true );
        this.darkRefControl = this.makeSlider( this.stretchGroup, "Dark reference %:", 1, 50, 0, 49,
            "<p>Percentile of each channel treated as neutral black. Lower it if dark dust lanes " +
            "or background show a colour cast (usually blue), which happens when nebulosity fills " +
            "the frame. 50 uses the median, like version 1.0. Doesn't change brightness or contrast.</p>", true );
        this.leftPanel.sizer.add( this.stretchGroup );

        // Finishing
        this.finishGroup = new GroupBox( this.leftPanel );
        this.finishGroup.title = "Finishing";
        this.finishGroup.sizer = new VerticalSizer;
        this.finishGroup.sizer.margin = 6;
        this.finishGroup.sizer.spacing = 4;

        this.lumControl = this.makeSlider( this.finishGroup, "Ha luminance %:", 0, 100, 0, 100,
            "<p>How much of the image brightness comes from Ha, which usually has the best " +
            "signal and detail. The colour still comes from the mix.</p>", true );
        this.greenControl = this.makeSlider( this.finishGroup, "Green removal %:", 0, 100, 0, 100,
            "<p>Reduces green where it exceeds the mean of red and blue (SCNR average neutral). " +
            "Useful with SHO-style mixes.</p>", true );
        this.satControl = this.makeSlider( this.finishGroup, "Saturation %:", 0, 250, 0, 250,
            "<p>Colour saturation around the per-pixel mean.</p>", true );
        this.leftPanel.sizer.add( this.finishGroup );

        this.leftPanel.sizer.addStretch();

        this.createButton = new PushButton( this.leftPanel );
        this.createButton.text = "Create full-size image";
        this.createButton.toolTip = "Apply the current mix to the full-resolution channels and open the result.";
        this.createButton.enabled = false;
        this.createButton.onClick = () => { this.generateFinal(); };
        this.leftPanel.sizer.add( this.createButton );

        this.resetButton = new PushButton( this.leftPanel );
        this.resetButton.text = "Reset to defaults";
        this.resetButton.onClick = () => { this.applyDefaults(); };

        this.exitButton = new PushButton( this.leftPanel );
        this.exitButton.text = "Exit";
        this.exitButton.onClick = () => { this.ok(); };

        this.newInstanceButton = new ToolButton( this.leftPanel );
        this.newInstanceButton.icon = this.scaledResource( ":/process-interface/new-instance.png" );
        this.newInstanceButton.setScaledFixedSize( 24, 24 );
        this.newInstanceButton.toolTip = "<p>New Instance: drag this onto the workspace to save the " +
            "current mix, stretch settings and channel choices as a process icon. Opening the icon " +
            "starts the mixer with those settings, and loads the channels if they're open.</p>";
        this.newInstanceButton.onMousePress = () =>
        {
            this.newInstanceButton.hasFocus = true;
            this.newInstanceButton.pushed = false;
            this.exportParameters();
            this.newInstance();
        };

        let buttonRow = new HorizontalSizer;
        buttonRow.spacing = 6;
        buttonRow.add( this.newInstanceButton );
        buttonRow.add( this.resetButton );
        buttonRow.addStretch();
        buttonRow.add( this.exitButton );
        this.leftPanel.sizer.add( buttonRow );

        this.creditLabel = new Label( this.leftPanel );
        this.creditLabel.useRichText = true;
        this.creditLabel.wordWrapping = true;
        this.creditLabel.text = "<small>Based on Perfect Palette Picker by Franklin Marek, " +
            "<a href=\"http://www.setiastro.com\">www.setiastro.com</a> (CC BY-NC 4.0).</small>";
        this.creditLabel.onMousePress = () => { Dialog.openBrowser( "http://www.setiastro.com" ); };
        this.leftPanel.sizer.add( this.creditLabel );

        // ---------------- Mixer panel ----------------
        this.mixPanel = new Control( this );
        this.mixPanel.sizer = new VerticalSizer;
        this.mixPanel.sizer.spacing = 6;
        this.mixPanel.setScaledFixedWidth( 300 );

        this.mixControls = {};
        let lineInfo = [
            [ "H", "Ha (656 nm)",   "#c03030" ],
            [ "S", "SII (672 nm)",  "#c07020" ],
            [ "O", "OIII (501 nm)", "#2070c0" ]
        ];
        for ( let [ key, title, colour ] of lineInfo )
        {
            let group = new GroupBox( this.mixPanel );
            group.title = title;
            group.styleSheet = "QGroupBox::title { color: " + colour + "; font-weight: bold; }";
            group.sizer = new VerticalSizer;
            group.sizer.margin = 6;
            group.sizer.spacing = 4;
            this.mixControls[key] = [
                this.makeSlider( group, "Red %:",   0, 200, 0, 200, "<p>Percentage of " + title + " sent to red.</p>",   false ),
                this.makeSlider( group, "Green %:", 0, 200, 0, 200, "<p>Percentage of " + title + " sent to green.</p>", false ),
                this.makeSlider( group, "Blue %:",  0, 200, 0, 200, "<p>Percentage of " + title + " sent to blue.</p>",  false )
            ];
            for ( let c = 0; c < 3; ++c )
            {
                let cc = c;
                this.mixControls[key][c].onValueUpdated = v =>
                {
                    this.weights[key][cc] = v/100;
                    this.presetIndex = this.matchPreset();
                    this.updateTileSelection();
                    this.scheduleRefresh( false );
                };
            }
            this.mixPanel.sizer.add( group );
        }

        this.mixInfoLabel = new Label( this.mixPanel );
        this.mixInfoLabel.wordWrapping = true;
        this.mixInfoLabel.useRichText = true;
        this.mixInfoLabel.text = "<p>Pick a preset below the preview, then fine-tune here. " +
            "Values above 100% boost a line.</p>";
        this.mixPanel.sizer.add( this.mixInfoLabel );
        this.mixPanel.sizer.addStretch();

        // ---------------- Preview + tiles ----------------
        this.previewControl = new Control( this );
        this.previewControl.setScaledMinSize( 640, 430 );
        this.previewControl.onPaint = () =>
        {
            let ctl = this.previewControl;
            let g = new Graphics( ctl );
            g.fillRect( 0, 0, ctl.width, ctl.height, new Brush( 0xFF181818 ) );
            if ( this.previewBmp )
                this.drawFitted( g, this.previewBmp, 0, 0, ctl.width, ctl.height );
            else
            {
                g.pen = new Pen( 0xFFB0B0B0 );
                g.drawTextRect( new Rect( 0, 0, ctl.width, ctl.height ),
                    "Select channels and click Load channels",
                    TextAlignment.Center | TextAlignment.VertCenter );
            }
            g.end();
        };
        this.previewControl.onResize = () => { this.previewControl.update(); };

        this.tiles = [];
        this.tileSizer = new VerticalSizer;
        this.tileSizer.spacing = 4;
        const tileCols = 4;
        for ( let r = 0; r < Math.ceil( PRESETS.length/tileCols ); ++r )
        {
            let row = new HorizontalSizer;
            row.spacing = 4;
            for ( let c = 0; c < tileCols; ++c )
            {
                let idx = r*tileCols + c;
                if ( idx >= PRESETS.length )
                {
                    row.addStretch();
                    continue;
                }
                row.add( this.makeTile( idx ), 1 );
            }
            this.tileSizer.add( row );
        }

        this.rightSizer = new VerticalSizer;
        this.rightSizer.spacing = 6;
        this.rightSizer.add( this.previewControl, 3 );
        this.rightSizer.add( this.tileSizer, 1 );

        // ---------------- Main layout ----------------
        this.sizer = new HorizontalSizer;
        this.sizer.margin = 8;
        this.sizer.spacing = 8;
        this.sizer.add( this.leftPanel );
        this.sizer.add( this.mixPanel );
        this.sizer.add( this.rightSizer, 1 );

        this.windowTitle = "Narrowband Palette Mixer v" + VERSION;
        this.userResizable = true;

        this.loadSettings();
        let autoLoad = this.importParameters();
        this.syncControls();
        this.updateStretchEnabled();
        this.adjustToContents();

        // Launched from a process icon with its channels open: load them once
        // the dialog is visible.
        this.autoLoadTimer = new Timer;
        this.autoLoadTimer.interval   = 0.2;
        this.autoLoadTimer.singleShot = true;
        this.autoLoadTimer.onTimeout  = () => { this.loadChannels(); };
        this.onShow = () =>
        {
            if ( autoLoad )
            {
                autoLoad = false;
                this.autoLoadTimer.start();
            }
        };
    }

    // ---- UI construction helpers ----

    makeSlider( parent, text, lo, hi, precision, steps, tip, triggersTiles )
    {
        let nc = new NumericControl( parent );
        nc.label.text = text;
        nc.label.setFixedWidth( this.font.width( "Dark reference %:" ) + 6 );
        nc.setRange( lo, hi );
        nc.setPrecision( precision );
        nc.slider.setRange( 0, steps );
        nc.slider.setScaledMinWidth( 110 );
        nc.setReal( precision > 0 );
        nc.toolTip = tip;
        if ( triggersTiles )
            nc.onValueUpdated = () => { this.scheduleRefresh( true ); };
        parent.sizer.add( nc );
        return nc;
    }

    makeTile( idx )
    {
        let ctl = new Control( this );
        ctl.setScaledMinSize( 150, 100 );
        ctl.bitmap = null;
        ctl.presetIndex = idx;
        ctl.toolTip = "Load the \"" + PRESETS[idx].name + "\" mix into the sliders.";
        ctl.onPaint = () =>
        {
            let g = new Graphics( ctl );
            g.fillRect( 0, 0, ctl.width, ctl.height, new Brush( 0xFF202020 ) );
            if ( ctl.bitmap )
                this.drawFitted( g, ctl.bitmap, 0, 0, ctl.width, ctl.height );
            let selected = (this.presetIndex == idx);
            g.pen = new Pen( 0xFF000000 );
            g.drawText( 6, ctl.height - 5, PRESETS[idx].name );
            g.pen = new Pen( selected ? 0xFF40FF40 : 0xFFFFFFFF );
            g.drawText( 5, ctl.height - 6, PRESETS[idx].name );
            if ( selected )
            {
                g.pen = new Pen( 0xFF40FF40, 2 );
                g.drawRect( 1, 1, ctl.width - 1, ctl.height - 1 );
            }
            g.end();
        };
        ctl.onMousePress = () => { this.selectPreset( idx ); };
        this.tiles.push( ctl );
        return ctl;
    }

    drawFitted( g, bmp, x0, y0, w, h )
    {
        let s = Math.min( w/bmp.width, h/bmp.height );
        let dw = bmp.width*s, dh = bmp.height*s;
        let x = x0 + (w - dw)/2, y = y0 + (h - dh)/2;
        g.smoothInterpolation = true;
        g.drawScaledBitmap( x, y, x + dw, y + dh, bmp );
    }

    // Preselect combos whose view IDs look like Ha/OIII/SII masters, e.g.
    // "..._FILTER_H_mono" (WBPP) or "MasterLight_H". Patterns are tried in
    // order; underscores are required around bare letters so IDs such as
    // "EXPOSURE_300_00s" don't match SII.
    autoSelectChannels()
    {
        let pick = ( combo, patterns ) =>
        {
            for ( let re of patterns )
                for ( let i = 1; i < combo.numberOfItems; ++i )
                    if ( re.test( combo.itemText( i ) ) )
                    {
                        combo.currentItem = i;
                        return;
                    }
        };
        pick( this.comboHa,   [ /FILTER_?H(a|alpha)?(?![a-z0-9])/i, /(^|_)(Ha|Halpha|H)(_|$)/i ] );
        pick( this.comboOIII, [ /FILTER_?O(III|3)?(?![a-z0-9])/i,   /(^|_)(OIII|O3|O)(_|$)/i ] );
        pick( this.comboSII,  [ /FILTER_?S(II|2)?(?![a-z0-9])/i,    /(^|_)(SII|S2|S)(_|$)/i ] );
    }

    updateStretchEnabled()
    {
        this.targetControl.enabled = this.linearCheckbox.checked;
        this.clipControl.enabled   = this.linearCheckbox.checked;
    }

    // ---- Presets and parameters ----

    presetWeights( idx )
    {
        let p = PRESETS[idx];
        return { H: p.H.map( v => v/100 ), O: p.O.map( v => v/100 ), S: p.S.map( v => v/100 ) };
    }

    matchPreset()
    {
        for ( let i = 0; i < PRESETS.length; ++i )
        {
            let same = true;
            for ( let k of [ "H", "O", "S" ] )
                for ( let c = 0; c < 3; ++c )
                    if ( Math.round( this.weights[k][c]*100 ) != PRESETS[i][k][c] )
                        same = false;
            if ( same )
                return i;
        }
        return -1;
    }

    selectPreset( idx )
    {
        this.presetIndex = idx;
        this.weights = this.presetWeights( idx );
        this.syncMixControls();
        this.updateTileSelection();
        this.scheduleRefresh( false );
    }

    updateTileSelection()
    {
        for ( let t of this.tiles )
            t.update();
    }

    syncMixControls()
    {
        for ( let k of [ "H", "O", "S" ] )
            for ( let c = 0; c < 3; ++c )
                this.mixControls[k][c].setValue( Math.round( this.weights[k][c]*100 ) );
    }

    syncControls()
    {
        this.syncMixControls();
        this.targetControl.setValue( this.params.target );
        this.clipControl.setValue( this.params.clip );
        this.darkRefControl.setValue( this.params.darkRef );
        this.lumControl.setValue( this.params.haLum );
        this.greenControl.setValue( this.params.green );
        this.satControl.setValue( this.params.sat );
        this.linearCheckbox.checked = this.params.linear;
        this.normaliseCheckbox.checked = this.params.normalise;
    }

    applyDefaults()
    {
        this.params = Object.assign( {}, DEFAULTS );
        this.presetIndex = DEFAULTS.preset;
        this.weights = this.presetWeights( DEFAULTS.preset );
        this.syncControls();
        this.updateStretchEnabled();
        this.updateTileSelection();
        this.scheduleRefresh( true );
    }

    currentOptions()
    {
        return {
            linear:    this.linearCheckbox.checked,
            normalise: this.normaliseCheckbox.checked,
            target:    this.targetControl.value,
            clip:      this.clipControl.value,
            darkRef:   this.darkRefControl.value/100,
            haLum:     this.lumControl.value/100,
            green:     this.greenControl.value/100,
            sat:       this.satControl.value/100
        };
    }

    // ---- Settings persistence ----

    loadSettings()
    {
        this.params = Object.assign( {}, DEFAULTS );
        let readNum = ( key, def ) =>
        {
            let v = Settings.read( SETTINGS_KEY + "/" + key, DataType.Double );
            return (Settings.lastReadOK && v !== null && isFinite( v )) ? v : def;
        };
        let readBool = ( key, def ) =>
        {
            let v = Settings.read( SETTINGS_KEY + "/" + key, DataType.Boolean );
            return (Settings.lastReadOK && v !== null) ? v : def;
        };
        for ( let k of [ "target", "clip", "darkRef", "haLum", "green", "sat" ] )
            this.params[k] = readNum( k, DEFAULTS[k] );
        this.params.linear    = readBool( "linear", DEFAULTS.linear );
        this.params.normalise = readBool( "normalise", DEFAULTS.normalise );
        for ( let k of [ "H", "O", "S" ] )
            for ( let c = 0; c < 3; ++c )
                this.weights[k][c] = readNum( "w" + k + c, this.weights[k][c] );
        this.presetIndex = this.matchPreset();
    }

    saveSettings()
    {
        let o = this.currentOptions();
        let put = ( key, v ) => Settings.write( SETTINGS_KEY + "/" + key, DataType.Double, v );
        put( "target", o.target );
        put( "clip",   o.clip );
        put( "darkRef", this.darkRefControl.value );
        put( "haLum",  this.lumControl.value );
        put( "green",  this.greenControl.value );
        put( "sat",    this.satControl.value );
        Settings.write( SETTINGS_KEY + "/linear",    DataType.Boolean, o.linear );
        Settings.write( SETTINGS_KEY + "/normalise", DataType.Boolean, o.normalise );
        for ( let k of [ "H", "O", "S" ] )
            for ( let c = 0; c < 3; ++c )
                put( "w" + k + c, this.weights[k][c] );
    }

    // ---- Process icon parameters ----

    // Stores the current state in the script instance, for New Instance.
    exportParameters()
    {
        Parameters.clear();
        Parameters.set( "version",   VERSION );
        Parameters.set( "target",    this.targetControl.value );
        Parameters.set( "clip",      this.clipControl.value );
        Parameters.set( "darkRef",   this.darkRefControl.value );
        Parameters.set( "haLum",     this.lumControl.value );
        Parameters.set( "green",     this.greenControl.value );
        Parameters.set( "sat",       this.satControl.value );
        Parameters.set( "linear",    this.linearCheckbox.checked );
        Parameters.set( "normalise", this.normaliseCheckbox.checked );
        for ( let k of [ "H", "O", "S" ] )
            for ( let c = 0; c < 3; ++c )
                Parameters.set( "w" + k + c, this.weights[k][c] );
        let id = combo => combo.currentItem > 0 ? combo.itemText( combo.currentItem ) : "";
        Parameters.set( "viewHa",   id( this.comboHa ) );
        Parameters.set( "viewOIII", id( this.comboOIII ) );
        Parameters.set( "viewSII",  id( this.comboSII ) );
        Parameters.set( "viewOSC1", id( this.comboOSC1 ) );
        Parameters.set( "viewOSC2", id( this.comboOSC2 ) );
    }

    // Applies parameters from a process icon, if the script was launched from
    // one. Returns true if at least one stored channel view is open, so the
    // channels can be loaded straight away.
    importParameters()
    {
        if ( !Parameters.has( "target" ) )
            return false;

        for ( let k of [ "target", "clip", "darkRef", "haLum", "green", "sat" ] )
            if ( Parameters.has( k ) )
                this.params[k] = Parameters.getReal( k );
        if ( Parameters.has( "linear" ) )
            this.params.linear = Parameters.getBoolean( "linear" );
        if ( Parameters.has( "normalise" ) )
            this.params.normalise = Parameters.getBoolean( "normalise" );
        for ( let k of [ "H", "O", "S" ] )
            for ( let c = 0; c < 3; ++c )
                if ( Parameters.has( "w" + k + c ) )
                    this.weights[k][c] = Parameters.getReal( "w" + k + c );
        this.presetIndex = this.matchPreset();

        let found = false;
        let select = ( combo, key ) =>
        {
            if ( !Parameters.has( key ) )
                return;
            let id = Parameters.getString( key );
            if ( id.length == 0 )
            {
                combo.currentItem = 0;
                return;
            }
            for ( let i = 1; i < combo.numberOfItems; ++i )
                if ( combo.itemText( i ) == id )
                {
                    combo.currentItem = i;
                    found = true;
                    return;
                }
            console.warningln( "** Channel image " + id + " from the process icon isn't open." );
        };
        select( this.comboHa,   "viewHa" );
        select( this.comboOIII, "viewOIII" );
        select( this.comboSII,  "viewSII" );
        select( this.comboOSC1, "viewOSC1" );
        select( this.comboOSC2, "viewOSC2" );
        return found;
    }

    // ---- Loading ----

    comboView( combo )
    {
        if ( combo.currentItem <= 0 )
            return null;
        let w = ImageWindow.windowById( combo.itemText( combo.currentItem ) );
        return (w && !w.isNull) ? w.mainView : null;
    }

    loadChannels()
    {
        let vHa = this.comboView( this.comboHa );
        let vO  = this.comboView( this.comboOIII );
        let vS  = this.comboView( this.comboSII );
        let vD1 = this.comboView( this.comboOSC1 );
        let vD2 = this.comboView( this.comboOSC2 );

        let imgH = null, imgO = null, imgS = null;

        console.show();
        console.writeln( "<end><cbr><br><b>Narrowband Palette Mixer: loading channels</b>" );

        try
        {
            let oList = [];
            if ( vD1 )
            {
                if ( vD1.image.numberOfChannels < 3 )
                    throw new Error( "The OSC HaO3 image " + vD1.id + " isn't a colour image." );
                imgH = extractChannel( vD1.image, 0 );
                oList.push( averageChannels( vD1.image, 1, vD1.image, 2 ) );
            }
            if ( vD2 )
            {
                if ( vD2.image.numberOfChannels < 3 )
                    throw new Error( "The OSC S2O3 image " + vD2.id + " isn't a colour image." );
                imgS = extractChannel( vD2.image, 0 );
                oList.push( averageChannels( vD2.image, 1, vD2.image, 2 ) );
            }
            if ( oList.length == 2 )
                imgO = averageChannels( oList[0], 0, oList[1], 0 );
            else if ( oList.length == 1 )
                imgO = oList[0];

            // Mono masters override anything derived from OSC images.
            let mono = v =>
            {
                if ( v.image.numberOfChannels != 1 )
                    console.warningln( "** " + v.id + " has more than one channel; using the first." );
                return v.image.numberOfChannels == 1 ? v.image : extractChannel( v.image, 0 );
            };
            if ( vHa ) imgH = mono( vHa );
            if ( vO )  imgO = mono( vO );
            if ( vS )  imgS = mono( vS );

            if ( !imgH && !imgS )
                throw new Error( "Select a Ha or SII channel (or an OSC dual-band image)." );

            let all = [ imgH, imgO, imgS ].filter( x => x );
            for ( let x of all )
                if ( x.width != all[0].width || x.height != all[0].height )
                    throw new Error( "All channels must have the same dimensions. Register and crop them first." );

            console.writeln( "Analysing channels ..." );
            processEvents();
            let ch = {};
            ch.H = imgH ? analyseChannel( imgH ) : null;
            ch.S = imgS ? analyseChannel( imgS ) : null;
            ch.O = imgO ? analyseChannel( imgO ) : null;
            if ( !ch.S )
            {
                console.warningln( "** No SII channel: using Ha in its place." );
                ch.S = ch.H;
            }
            if ( !ch.H )
            {
                console.warningln( "** No Ha channel: using SII in its place." );
                ch.H = ch.S;
            }
            if ( !ch.O )
                console.warningln( "** No OIII channel: OIII sliders have no effect." );

            for ( let k of [ "H", "O", "S" ] )
                if ( ch[k] )
                {
                    let s = ch[k].stats;
                    console.writeln( format( "%s: median %.6f, MAD %.6f, signal level %.6f, " +
                        "dark (10%%) %.6f, %.1f%% zero/clipped pixels ignored",
                        k, s.median, s.mad, s.pHigh, quantileOfSorted( s.sorted, 0.10 ), 100*s.clipped ) );
                }

            this.channels = ch;

            let pw = ch.H.pw, ph = ch.H.ph;
            let step = Math.max( 1, Math.ceil( Math.max( pw, ph )/TILE_MAX ) );
            this.tileArrays = {};
            for ( let k of [ "H", "O", "S" ] )
                this.tileArrays[k] = ch[k] ? makeTileArray( ch[k].preview, pw, ph, step ) : null;

            let coef = computeCoefficients( this.statsObject(), this.weights, this.currentOptions() );
            console.writeln( format( "Normalisation gains: OIII x%.2f, SII x%.2f", coef.gain.O, coef.gain.S ) );

            this.createButton.enabled = true;
            this.refresh( true );
            console.writeln( "Ready." );
        }
        catch ( e )
        {
            console.criticalln( "*** " + e.message );
            new MessageBox( e.message, "Narrowband Palette Mixer", StdIcon.Error, StdButton.Ok ).execute();
        }
    }

    statsObject()
    {
        let ch = this.channels;
        return {
            H: ch.H.stats,
            O: ch.O ? ch.O.stats : null,
            S: ch.S.stats
        };
    }

    // ---- Rendering ----

    scheduleRefresh( tilesToo )
    {
        if ( tilesToo )
            this.tilesDirty = true;
        if ( !this.channels )
            return;
        this.updateTimer.stop();
        this.updateTimer.start();
    }

    refresh( forceTiles )
    {
        if ( !this.channels )
            return;
        let opts  = this.currentOptions();
        let stats = this.statsObject();
        let ch    = this.channels;

        let pw = ch.H.pw, ph = ch.H.ph, n = pw*ph;
        let R = new Float32Array( n ), G = new Float32Array( n ), B = new Float32Array( n );
        processPixels( ch.H.preview, ch.O ? ch.O.preview : null, ch.S.preview, n,
                       computeCoefficients( stats, this.weights, opts ), R, G, B );
        this.previewBmp = renderBitmap( pw, ph, R, G, B );
        this.previewControl.update();

        if ( forceTiles || this.tilesDirty )
        {
            let t = this.tileArrays;
            let tw = t.H.w, th = t.H.h, tn = tw*th;
            let tR = new Float32Array( tn ), tG = new Float32Array( tn ), tB = new Float32Array( tn );
            for ( let i = 0; i < this.tiles.length; ++i )
            {
                processPixels( t.H.data, t.O ? t.O.data : null, t.S.data, tn,
                               computeCoefficients( stats, this.presetWeights( i ), opts ), tR, tG, tB );
                this.tiles[i].bitmap = renderBitmap( tw, th, tR, tG, tB );
                this.tiles[i].update();
            }
            this.tilesDirty = false;
        }
    }

    // ---- Full-size output ----

    generateFinal()
    {
        if ( !this.channels )
            return;
        let ch   = this.channels;
        let opts = this.currentOptions();
        let coef = computeCoefficients( this.statsObject(), this.weights, opts );

        let srcH = ch.H.image, srcS = ch.S.image, srcO = ch.O ? ch.O.image : null;
        let w = srcH.width, h = srcH.height;

        let name = this.presetIndex >= 0 ? PRESETS[this.presetIndex].name : "Custom";
        let id = "Palette_" + name.replace( /[^A-Za-z0-9]+/g, "_" ).replace( /_+$/, "" );

        console.show();
        console.writeln( "<end><cbr><br><b>Narrowband Palette Mixer: creating " + id + " (" + w + "x" + h + ")</b>" );
        let t0 = Date.now();

        let win = new ImageWindow( w, h, 3, 32, true, true, id );
        let view = win.mainView;
        view.beginProcess( UndoFlag.NoSwapFile );
        let out = view.image;
        try
        {
            for ( let y0 = 0; y0 < h; y0 += STRIP_ROWS )
            {
                let r = new Rect( 0, y0, w, Math.min( h, y0 + STRIP_ROWS ) );
                let n = r.area;
                let a = new Float32Array( n ), s = new Float32Array( n );
                let o = srcO ? new Float32Array( n ) : null;
                srcH.getSamples( a, r, 0 );
                srcS.getSamples( s, r, 0 );
                if ( o )
                    srcO.getSamples( o, r, 0 );
                let R = new Float32Array( n ), G = new Float32Array( n ), B = new Float32Array( n );
                processPixels( a, o, s, n, coef, R, G, B );
                out.setSamples( R, r, 0 );
                out.setSamples( G, r, 1 );
                out.setSamples( B, r, 2 );
            }
        }
        finally
        {
            view.endProcess();
        }

        let pct = v => Math.round( v*100 );
        let kw = [
            new FITSKeyword( "HISTORY", "", "Narrowband Palette Mixer " + VERSION + ": " + name ),
            new FITSKeyword( "HISTORY", "", format( "Ha->RGB %d/%d/%d  SII->RGB %d/%d/%d  OIII->RGB %d/%d/%d",
                pct( this.weights.H[0] ), pct( this.weights.H[1] ), pct( this.weights.H[2] ),
                pct( this.weights.S[0] ), pct( this.weights.S[1] ), pct( this.weights.S[2] ),
                pct( this.weights.O[0] ), pct( this.weights.O[1] ), pct( this.weights.O[2] ) ) ),
            new FITSKeyword( "HISTORY", "", format( "linear=%s normalise=%s background=%.3f clip=%.1f darkRef=%d%%",
                opts.linear ? "T" : "F", opts.normalise ? "T" : "F", opts.target, opts.clip, pct( opts.darkRef ) ) ),
            new FITSKeyword( "HISTORY", "", format( "HaLum=%d%% green=%d%% sat=%d%%",
                pct( opts.haLum ), pct( opts.green ), pct( opts.sat ) ) )
        ];
        win.keywords = win.keywords.concat( kw );

        win.show();
        win.bringToFront();
        console.writeln( format( "Done in %.1f s.", (Date.now() - t0)/1000 ) );
    }

    onHide()
    {
        this.updateTimer.stop();
        this.autoLoadTimer.stop();
        this.saveSettings();
    }
};

// ============================================================================
// Main
// ============================================================================

function main()
{
    console.writeln( "<end><cbr>Narrowband Palette Mixer v" + VERSION +
                     " (based on Perfect Palette Picker by Franklin Marek)" );
    let dialog = new NarrowbandPaletteMixerDialog();
    dialog.execute();
}

main();
