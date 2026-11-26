using System.ComponentModel;
using System.Drawing.Drawing2D;

namespace BigReplay.Desktop;

/// <summary>Small rotating arc used beside the primary recorder state.</summary>
internal sealed class Spinner : Control
{
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 50 };
    private float _angle;
    private Color _spinnerColor = Color.Gray;
    private bool _active;

    public Spinner()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);
        Size = new Size(24, 24);
        _timer.Tick += (_, _) =>
        {
            _angle = (_angle + 30) % 360;
            Invalidate();
        };
    }

    [DefaultValue(typeof(Color), "Gray")]
    public Color SpinnerColor
    {
        get => _spinnerColor;
        set
        {
            if (_spinnerColor == value)
            {
                return;
            }
            _spinnerColor = value;
            Invalidate();
        }
    }

    [DefaultValue(false)]
    public bool Active
    {
        get => _active;
        set
        {
            if (_active == value)
            {
                return;
            }
            _active = value;
            if (value)
            {
                _timer.Start();
            }
            else
            {
                _timer.Stop();
            }
            Invalidate();
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        const int padding = 4;
        var rect = new Rectangle(padding, padding, Width - padding * 2, Height - padding * 2);
        using var track = new Pen(Color.FromArgb(38, _spinnerColor), 2f);
        e.Graphics.DrawEllipse(track, rect);
        using var arc = new Pen(_spinnerColor, 2.5f)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round,
        };
        e.Graphics.DrawArc(arc, rect, _angle, 100f);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
        }
        base.Dispose(disposing);
    }
}
