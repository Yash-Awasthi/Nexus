package io.github.hectorvent.floci.services.cloudwatch.metrics.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import io.quarkus.runtime.annotations.RegisterForReflection;

import java.util.ArrayList;
import java.util.List;

@RegisterForReflection
@JsonIgnoreProperties(ignoreUnknown = true)
public class MetricDatum {

    private String namespace;
    private String metricName;
    private List<Dimension> dimensions = new ArrayList<>();
    private long timestamp;
    private double value;
    private double sampleCount;
    private double sum;
    private double minimum;
    private double maximum;
    private String unit;

    public MetricDatum() {}

    public String getNamespace() { return namespace; }
    public void setNamespace(String namespace) { this.namespace = namespace; }

    public String getMetricName() { return metricName; }
    public void setMetricName(String metricName) { this.metricName = metricName; }

    public List<Dimension> getDimensions() { return dimensions; }
    public void setDimensions(List<Dimension> dimensions) { this.dimensions = dimensions; }

    public long getTimestamp() { return timestamp; }
    public void setTimestamp(long timestamp) { this.timestamp = timestamp; }

    public double getValue() { return value; }
    public void setValue(double value) { this.value = value; }

    public double getSampleCount() { return sampleCount; }
    public void setSampleCount(double sampleCount) { this.sampleCount = sampleCount; }

    public double getSum() { return sum; }
    public void setSum(double sum) { this.sum = sum; }

    public double getMinimum() { return minimum; }
    public void setMinimum(double minimum) { this.minimum = minimum; }

    public double getMaximum() { return maximum; }
    public void setMaximum(double maximum) { this.maximum = maximum; }

    public String getUnit() { return unit; }
    public void setUnit(String unit) { this.unit = unit; }
}
